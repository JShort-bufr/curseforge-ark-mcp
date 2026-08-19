import { z } from "zod";
import { MAX_EXCLUDE_CATEGORY_IDS, MAX_INCLUDE_CATEGORY_IDS, MAX_PAGE_SIZE } from "../allowlist.js";
import { asArray, asNumber } from "../coerce.js";
import { CurseForgeError } from "../errors.js";
import type { ToolDef } from "../registry.js";
import {
  CURATION_NOTE,
  HANDOFF_NOTE,
  pageBlock,
  rawModCategoryIds,
  shapeMod,
  verificationBlock,
  type ToolContext,
} from "./context.js";

/**
 * `search_mods` — E2, GET /v1/mods/search.
 *
 * `gameId` comes from §5's runtime resolution and is NEVER a parameter. Letting
 * a caller pass one would reintroduce exactly the failure the resolver exists to
 * prevent: `gameId` is a required filter, so a wrong value returns a clean,
 * empty, entirely wrong result set rather than an error.
 *
 * class_id / category_id / category_ids are forwarded to CurseForge (include).
 * exclude_category_ids is LOCAL: CurseForge has no exclude parameter. Pagination
 * therefore still describes the unfiltered upstream page.
 */
function formatCategoryIdsQuery(ids: number[]): string {
  return `[${ids.join(",")}]`;
}

export function searchTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "search_mods",
      title: "Search ARK: Survival Ascended mods",
      tier: 1,
      description:
        "Search the CurseForge catalog for ARK: Survival Ascended mods. The gameId is resolved at runtime " +
        "from GET /v1/games and is not a parameter — a wrong gameId returns a clean, empty, wrong result " +
        `set rather than an error. Page size is capped at ${MAX_PAGE_SIZE} by CurseForge and an over-large ` +
        "request is REFUSED rather than clamped, so that a page is never mistaken for a complete set. Every " +
        "result states its pagination and whether more results exist, and says so explicitly when the tail " +
        "of the result set is beyond the API's addressable window. class_id, category_id, and category_ids " +
        "are include filters sent to CurseForge (discover ids via list_categories). exclude_category_ids is " +
        "applied locally after the page returns — CurseForge has no exclude parameter — so pagination still " +
        "describes the unfiltered upstream page. A hit is a catalog row, not an install: inspect file_name " +
        "and file_length_bytes, then hand curseforge_mod_ids to nitrado-ark-mcp. Read-only.",
      inputSchema: {
        search_filter: z
          .string()
          .min(1)
          .optional()
          .describe("Free-text search term, matched by CurseForge against mod names."),
        slug: z.string().min(1).optional().describe("Exact mod slug, when you already know it."),
        class_id: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Include: CurseForge section/class id. Discover via list_categories (is_class true)."),
        category_id: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Include: a single category id. Do not also pass category_ids."),
        category_ids: z
          .array(z.number().int().nonnegative())
          .min(1)
          .max(MAX_INCLUDE_CATEGORY_IDS)
          .optional()
          .describe(
            `Include: up to ${MAX_INCLUDE_CATEGORY_IDS} category ids. Overrides category_id at the vendor; ` +
              "this server refuses both at once rather than letting one silently win.",
          ),
        exclude_category_ids: z
          .array(z.number().int().nonnegative())
          .min(1)
          .max(MAX_EXCLUDE_CATEGORY_IDS)
          .optional()
          .describe(
            "LOCAL exclude after the page returns. CurseForge cannot exclude. Pagination still describes " +
              "the unfiltered upstream page. For gameplay-only, list_categories then pass Custom Cosmetics' id.",
          ),
        game_version: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Filter to files supporting this game version string. UNVERIFIED: whether ASA mods populate " +
              "game version fields at all is ADR-002 §14.3 U9.",
          ),
        sort_field: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe("CurseForge sort field, an integer 1-12 (documented range; the per-value meanings are not)."),
        sort_order: z.enum(["asc", "desc"]).optional().describe("Sort direction."),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Zero-based result offset. index + page_size must not exceed 10000."),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .optional()
          .describe(`Results per page, at most ${MAX_PAGE_SIZE}. Over that is refused, not clamped.`),
      },
      handler: async (args) => {
        const game = await ctx.games.resolve();
        const classId = args["class_id"] as number | undefined;
        const categoryId = args["category_id"] as number | undefined;
        const categoryIds = args["category_ids"] as number[] | undefined;
        const excludeCategoryIds = args["exclude_category_ids"] as number[] | undefined;

        if (categoryId !== undefined && categoryIds !== undefined) {
          throw new CurseForgeError(
            "ARGUMENT_REFUSED",
            "Pass category_id or category_ids, not both. CurseForge documents that categoryIds overrides " +
              "categoryId; this server refuses the pair rather than sending a query whose filter is not " +
              "the one you think you passed.",
            { detail: { category_id: categoryId, category_ids: categoryIds } },
          );
        }

        const query: Record<string, string | number | boolean | undefined> = {
          gameId: game.game_id,
          searchFilter: args["search_filter"] as string | undefined,
          slug: args["slug"] as string | undefined,
          classId,
          categoryId: categoryIds === undefined ? categoryId : undefined,
          categoryIds: categoryIds === undefined ? undefined : formatCategoryIdsQuery(categoryIds),
          gameVersion: args["game_version"] as string | undefined,
          sortField: args["sort_field"] as number | undefined,
          sortOrder: args["sort_order"] as string | undefined,
          index: args["index"] as number | undefined,
          pageSize: args["page_size"] as number | undefined,
        };

        const { data, page } = await ctx.client.request<unknown>({
          path: "v1/mods/search",
          query,
          tool: "search_mods",
        });

        const mods = asArray(data);
        if (mods === null) {
          throw new Error("GET /v1/mods/search returned a `data` value that is not an array.");
        }

        const excludeSet = new Set(excludeCategoryIds ?? []);
        const kept = excludeSet.size === 0 ? mods : mods.filter((mod) => !rawModCategoryIds(mod).some((id) => excludeSet.has(id)));
        const droppedOnThisPage = mods.length - kept.length;

        const shaped = kept.map(shapeMod);
        const handoffIds = shaped
          .map((mod) => asNumber(mod["id"]))
          .filter((id): id is number => id !== null);

        return {
          query_echo: {
            game_id: game.game_id,
            game_resolved_by: game.matched_by,
            ...Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)),
            exclude_category_ids: excludeCategoryIds ?? null,
          },
          result_count_on_this_page: shaped.length,
          upstream_result_count_on_this_page: mods.length,
          dropped_on_this_page_by_exclude: droppedOnThisPage,
          exclude_note:
            excludeSet.size === 0
              ? null
              : "exclude_category_ids was applied AFTER CurseForge returned this page. pagination, " +
                "has_more, and total_count describe the unfiltered upstream page, not the kept set. A thin " +
                "kept page is not 'the catalog has few matching mods'.",
          mods: shaped,
          handoff: {
            curseforge_mod_ids: handoffIds,
            sibling: "nitrado-ark-mcp",
            note: HANDOFF_NOTE,
          },
          curation_note: CURATION_NOTE,
          ...pageBlock(page),
          verification: verificationBlock(),
        };
      },
    },
  ];
}

import { z } from "zod";
import { MAX_PAGE_SIZE } from "../allowlist.js";
import { asArray } from "../coerce.js";
import type { ToolDef } from "../registry.js";
import { pageBlock, shapeMod, V0_NOTE, type ToolContext } from "./context.js";

/**
 * `search_mods` — E2, GET /v1/mods/search.
 *
 * `gameId` comes from §5's runtime resolution and is NEVER a parameter. Letting
 * a caller pass one would reintroduce exactly the failure the resolver exists to
 * prevent: `gameId` is a required filter, so a wrong value returns a clean,
 * empty, entirely wrong result set rather than an error.
 *
 * NO `classId` AND NO `categoryId` (ADR-002 §1.7, open question 3). ASA may
 * organise mods under a class that makes unclassed search noisy, but
 * GET /v1/categories is deferred, so nothing here could name a legal value. A
 * parameter whose legal values are unknown is a parameter that produces empty
 * result sets for reasons the caller cannot diagnose.
 */
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
        "of the result set is beyond the API's addressable window. Read-only. v0: all field paths unverified.",
      inputSchema: {
        search_filter: z
          .string()
          .min(1)
          .optional()
          .describe("Free-text search term, matched by CurseForge against mod names."),
        slug: z.string().min(1).optional().describe("Exact mod slug, when you already know it."),
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

        const query: Record<string, string | number | undefined> = {
          gameId: game.game_id,
          searchFilter: args["search_filter"] as string | undefined,
          slug: args["slug"] as string | undefined,
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
          // `data` was present but not an array. That is a shape error, not an
          // empty search — see §6: unknown is never returned as a value.
          throw new Error("GET /v1/mods/search returned a `data` value that is not an array.");
        }

        return {
          // The query is echoed so that an empty result is legible as an ANSWER
          // rather than as a shrug (§6). "No mods matched this" and "we could not
          // tell" must never look the same.
          query_echo: {
            game_id: game.game_id,
            game_resolved_by: game.matched_by,
            ...Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)),
          },
          result_count_on_this_page: mods.length,
          mods: mods.map(shapeMod),
          ...pageBlock(page),
          unverified: V0_NOTE,
        };
      },
    },
  ];
}

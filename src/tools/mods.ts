import { z } from "zod";
import { MAX_PAGE_SIZE } from "../allowlist.js";
import { asArray } from "../coerce.js";
import { CurseForgeError } from "../errors.js";
import type { ToolDef } from "../registry.js";
import { pageBlock, shapeFile, shapeMod, V0_NOTE, type ToolContext } from "./context.js";

const modIdParam = z
  .number()
  .int()
  .nonnegative()
  .describe("CurseForge numeric mod (project) id. Digits only — the allow-list will not match anything else.");

/** `get_mod` (E3), `list_mod_files` (E4), `get_mod_file` (E5). */
export function modTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "get_mod",
      title: "Get one mod record",
      tier: 1,
      description:
        "Fetch a single CurseForge mod (project) record by numeric id: name, slug, last-modified date, " +
        "website link, and its latestFiles with their raw releaseType integers. This is a single-record " +
        "endpoint, so it carries no pagination and none is invented. Read-only. v0: all field paths unverified.",
      inputSchema: { mod_id: modIdParam },
      handler: async (args) => {
        const modId = args["mod_id"] as number;
        const { data, page } = await ctx.client.request<unknown>({
          path: `v1/mods/${modId}`,
          tool: "get_mod",
        });
        return {
          requested_mod_id: modId,
          mod: shapeMod(data),
          // null on a single-record endpoint is NORMAL and is not synthesised
          // into a one-page descriptor (§3).
          pagination: page,
          unverified: V0_NOTE,
        };
      },
    },
    {
      name: "list_mod_files",
      title: "List a mod's files",
      tier: 1,
      description:
        "List the published files for one mod, paginated. Each file carries its raw releaseType integer, its " +
        "game versions, and its dependency edges with raw relationType integers — none of those integers is " +
        `mapped to a label, because CurseForge publishes no value table for either. Page size is capped at ` +
        `${MAX_PAGE_SIZE}; an over-large request is refused rather than clamped. Read-only. v0: all field ` +
        "paths unverified.",
      inputSchema: {
        mod_id: modIdParam,
        game_version: z
          .string()
          .min(1)
          .optional()
          .describe("Filter to files supporting this game version string. UNVERIFIED (§14.3 U9)."),
        index: z.number().int().min(0).optional().describe("Zero-based offset. index + page_size <= 10000."),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .optional()
          .describe(`At most ${MAX_PAGE_SIZE}. Over that is refused, not clamped.`),
      },
      handler: async (args) => {
        const modId = args["mod_id"] as number;
        const query: Record<string, string | number | undefined> = {
          gameVersion: args["game_version"] as string | undefined,
          index: args["index"] as number | undefined,
          pageSize: args["page_size"] as number | undefined,
        };

        const { data, page } = await ctx.client.request<unknown>({
          path: `v1/mods/${modId}/files`,
          query,
          tool: "list_mod_files",
        });

        const files = asArray(data);
        if (files === null) {
          throw new CurseForgeError(
            "UPSTREAM_SHAPE",
            `GET /v1/mods/${modId}/files returned a \`data\` value that is not an array, so the file list ` +
              `could not be read. This is reported as an error rather than as an empty list: a mod with no ` +
              `published files is a real answer and must not be confused with a shape this client cannot parse.`,
            { detail: { mod_id: modId } },
          );
        }

        return {
          requested_mod_id: modId,
          query_echo: Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)),
          // 0 here means "this mod has published no files matching the filter" —
          // a real answer, distinct from the error above (§6).
          file_count_on_this_page: files.length,
          files: files.map(shapeFile),
          ...pageBlock(page),
          unverified: V0_NOTE,
        };
      },
    },
    {
      name: "get_mod_file",
      title: "Get one mod file record",
      tier: 1,
      description:
        "Fetch a single file record for a mod by numeric mod id and file id: display name, file name, file " +
        "date, game versions, raw releaseType integer, and dependency edges with raw relationType integers. " +
        "NOTE: this tool does NOT return a download URL. The download-url endpoint is deliberately absent " +
        "from this server's endpoint allow-list (DEC-002 §11.3) — this server curates and reports, it never " +
        "downloads or installs. Read-only. v0: all field paths unverified.",
      inputSchema: {
        mod_id: modIdParam,
        file_id: z.number().int().nonnegative().describe("CurseForge numeric file id."),
      },
      handler: async (args) => {
        const modId = args["mod_id"] as number;
        const fileId = args["file_id"] as number;
        const { data, page } = await ctx.client.request<unknown>({
          path: `v1/mods/${modId}/files/${fileId}`,
          tool: "get_mod_file",
        });
        return {
          requested_mod_id: modId,
          requested_file_id: fileId,
          file: shapeFile(data),
          pagination: page,
          download_url_note:
            "No download URL is available from this server by design. GET /v1/mods/{modId}/files/{fileId}/" +
            "download-url is a documented read on the pinned host and is still refused, because it is not on " +
            "the endpoint allow-list (ADR-002 §1.7). Nitrado installs mods itself.",
          unverified: V0_NOTE,
        };
      },
    },
  ];
}

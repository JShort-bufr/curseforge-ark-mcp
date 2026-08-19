import { z } from "zod";
import { MAX_PAGE_SIZE } from "../allowlist.js";
import { asArray, asNumber, asString, at } from "../coerce.js";
import { CurseForgeError } from "../errors.js";
import type { ToolDef } from "../registry.js";
import { RELEASE_TYPE_NOTE, shapeFile, verificationBlock, type ToolContext } from "./context.js";

/**
 * `get_latest_file` — THE SURVEILLANCE PRIMITIVE (ADR-002 §7.1).
 *
 * The tool this repo exists for: "is there a newer version of project X than the
 * one my server is running?"
 *
 * ---------------------------------------------------------------------------
 * "Latest" default: `newest_by_file_date` (founder, 2026-08-18)
 * ---------------------------------------------------------------------------
 *
 * Newest by `fileDate`, newest matching a game version, and newest with a given
 * `releaseType` integer still give DIFFERENT ANSWERS. ADR-002 open question 2
 * left the definition as a product decision; the founder settled it: default to
 * newest by `fileDate`. The other two variants remain, with no silent mapping of
 * U7's release-type integers.
 *
 * A default is not a silent pick. The answer still restates the ordering it used,
 * what it filtered on, and whether the default was applied, EVERY TIME.
 *
 * The third variant is the awkward one and it is awkward honestly:
 * `newest_with_release_type` cannot be spelled "newest stable release", because
 * the `FileReleaseType` numeric enum is NOT PUBLISHED (§14.3 U7). The caller
 * supplies the integer it believes means release. That is worse ergonomics than
 * a named enum and it is the only version of this variant that is not a guess
 * wearing a label.
 */

type Selection = "newest_by_file_date" | "newest_matching_game_version" | "newest_with_release_type";

const DEFAULT_SELECTION: Selection = "newest_by_file_date";

function isSelection(value: unknown): value is Selection {
  return (
    value === "newest_by_file_date" ||
    value === "newest_matching_game_version" ||
    value === "newest_with_release_type"
  );
}

function resolveSelection(raw: unknown): { selection: Selection; defaultApplied: boolean } {
  if (raw === undefined) {
    return { selection: DEFAULT_SELECTION, defaultApplied: true };
  }
  if (isSelection(raw)) {
    return { selection: raw, defaultApplied: false };
  }
  throw new CurseForgeError(
    "ARGUMENT_REFUSED",
    `selection must be one of newest_by_file_date, newest_matching_game_version, newest_with_release_type. ` +
      `Got ${JSON.stringify(raw)}.`,
    { detail: { selection: raw } },
  );
}

interface Candidate {
  file: unknown;
  id: number | null;
  fileDateRaw: string | null;
  fileDateMs: number | null;
  releaseTypeRaw: number | null;
  gameVersions: string[];
}

function toCandidate(file: unknown): Candidate {
  const raw = asString(at(file, "fileDate"));
  const parsed = raw === null ? Number.NaN : Date.parse(raw);
  return {
    file,
    id: asNumber(at(file, "id")),
    fileDateRaw: raw,
    fileDateMs: Number.isFinite(parsed) ? parsed : null,
    releaseTypeRaw: asNumber(at(file, "releaseType")),
    gameVersions: (asArray(at(file, "gameVersions")) ?? []).filter(
      (version): version is string => typeof version === "string",
    ),
  };
}

export function latestFileTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "get_latest_file",
      title: "Get a mod's newest file, by a stated definition of newest",
      tier: 1,
      description:
        "Answers 'is there a newer file for this mod than the one I am running?' Default selection is " +
        "'newest_by_file_date' (founder decision 2026-08-18). The other definitions still give different " +
        "answers: 'newest_matching_game_version' restricts to files declaring a game version and then " +
        "orders by fileDate; 'newest_with_release_type' restricts to a releaseType INTEGER you supply and " +
        "then orders by fileDate. There is no named release/beta/alpha filter because CurseForge publishes " +
        "no value table for that integer (ADR-002 §14.3 U7) and this server will not invent one. Every " +
        "answer restates the ordering used, whether the default was applied, the filter applied, how many " +
        "candidates were considered, and where the candidates came from. Read-only.",
      inputSchema: {
        mod_id: z.number().int().nonnegative().describe("CurseForge numeric mod (project) id."),
        selection: z
          .enum(["newest_by_file_date", "newest_matching_game_version", "newest_with_release_type"])
          .default(DEFAULT_SELECTION)
          .describe(
            "Which question you are asking. Defaults to newest_by_file_date. These give different answers; " +
              "pass another variant only when that is the question you mean.",
          ),
        game_version: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Required when selection is 'newest_matching_game_version'. The game version string a candidate " +
              "file must declare. This server does NOT and MUST NOT learn your server's version from " +
              "Nitrado (ADR-002 §9) — you supply it.",
          ),
        release_type: z
          .number()
          .int()
          .optional()
          .describe(
            "Required when selection is 'newest_with_release_type'. The raw releaseType integer a candidate " +
              "must carry. Unmapped on purpose: CurseForge publishes no value table, so pass the integer you " +
              "mean rather than a label this server would have to guess.",
          ),
      },
      handler: async (args) => {
        const modId = args["mod_id"] as number;
        const { selection, defaultApplied } = resolveSelection(args["selection"]);
        const gameVersion = args["game_version"] as string | undefined;
        const releaseType = args["release_type"] as number | undefined;

        if (selection === "newest_matching_game_version" && gameVersion === undefined) {
          throw new CurseForgeError(
            "ARGUMENT_REFUSED",
            "selection 'newest_matching_game_version' requires game_version. It is refused rather than " +
              "defaulted to 'any version', because that would answer a different question than the one asked " +
              "and the answer would look identical to the right one.",
            { detail: { selection } },
          );
        }
        if (selection === "newest_with_release_type" && releaseType === undefined) {
          throw new CurseForgeError(
            "ARGUMENT_REFUSED",
            "selection 'newest_with_release_type' requires release_type, as a raw integer. There is no " +
              "default, and in particular this server does not assume that 1 means 'release': CurseForge " +
              "publishes no value table for FileReleaseType (ADR-002 §14.3 U7), and guessing it would risk " +
              "recommending an alpha build as a stable update.",
            { detail: { selection } },
          );
        }

        // E3 first. The mod record carries latestFiles, so the common case is one
        // request rather than two.
        const { data: mod } = await ctx.client.request<unknown>({
          path: `v1/mods/${modId}`,
          tool: "get_latest_file",
        });

        let source: "mod_record_latest_files" | "mod_files_endpoint" = "mod_record_latest_files";
        let pool = (asArray(at(mod, "latestFiles")) ?? []).map(toCandidate);
        let fallbackPage: unknown = null;

        let filtered = applyFilter(pool, selection, gameVersion, releaseType);

        // §7.1's fallback: E4 when the mod record carries no usable candidate.
        // "Usable" means "survives the filter", not merely "non-empty" — a mod
        // whose three latestFiles are all for the wrong game version has a
        // non-empty latestFiles and no answer to the question asked.
        if (filtered.length === 0) {
          const { data: files, page } = await ctx.client.request<unknown>({
            path: `v1/mods/${modId}/files`,
            query: {
              gameVersion: selection === "newest_matching_game_version" ? gameVersion : undefined,
              index: 0,
              pageSize: MAX_PAGE_SIZE,
            },
            tool: "get_latest_file",
          });
          source = "mod_files_endpoint";
          fallbackPage = page;
          pool = (asArray(files) ?? []).map(toCandidate);
          filtered = applyFilter(pool, selection, gameVersion, releaseType);
        }

        const commonEcho = {
          requested_mod_id: modId,
          selection,
          selection_default_applied: defaultApplied,
          ordering_field: "fileDate",
          filter_applied: describeFilter(selection, gameVersion, releaseType),
          candidate_source: source,
          candidates_before_filter: pool.length,
          candidates_after_filter: filtered.length,
          fallback_page: fallbackPage,
          release_type_note: RELEASE_TYPE_NOTE,
          verification: verificationBlock(),
        };

        if (filtered.length === 0) {
          // A REAL ANSWER, not a failure (§6). The mod exists and nothing it has
          // published matches. The echo above is what makes that legible.
          return {
            ...commonEcho,
            latest_file: null,
            answer: "no_matching_file",
            answer_note:
              "The mod record was read successfully and NO published file matched the stated selection. This " +
              "is an answer, not an error: the mod may have no files at all, or none matching your filter. " +
              "It is materially different from this tool having failed, which would have raised an error code.",
          };
        }

        const orderable = filtered.filter((candidate) => candidate.fileDateMs !== null);
        if (orderable.length === 0) {
          // Cannot order → UNKNOWN, which is an error rather than a value (§6).
          // Returning the first candidate and calling it "latest" would be a
          // fabricated ordering, which is the failure mode §7.1 names.
          throw new CurseForgeError(
            "UPSTREAM_SHAPE",
            `${filtered.length} candidate file(s) matched for mod ${modId}, but NONE carried a parseable ` +
              `\`fileDate\`, so "newest" cannot be determined. This is refused rather than answered with an ` +
              `arbitrary candidate: an unordered pick presented as "latest" is a fabricated answer. The ` +
              `\`fileDate\` field path itself is a hypothesis (ADR-002 §14.3 U4) — if this fires against a live ` +
              `response, the path is the first thing to check.`,
            {
              detail: {
                mod_id: modId,
                candidates_after_filter: filtered.length,
                file_dates_seen: filtered.map((candidate) => candidate.fileDateRaw),
                unverified_row: "U4",
              },
            },
          );
        }

        const winner = orderable.reduce((best, candidate) =>
          (candidate.fileDateMs as number) > (best.fileDateMs as number) ? candidate : best,
        );

        return {
          ...commonEcho,
          candidates_orderable_by_file_date: orderable.length,
          candidates_dropped_as_undateable: filtered.length - orderable.length,
          answer: "matched",
          latest_file: shapeFile(winner.file),
          comparison_hint:
            "To decide whether your server is behind, compare this file's id and fileDate against the file " +
            "you are running. This server does NOT know what your server is running and must not ask Nitrado " +
            "(ADR-002 §9) — the correlation happens in the conversation, not between the two servers.",
        };
      },
    },
  ];
}

function applyFilter(
  pool: readonly Candidate[],
  selection: Selection,
  gameVersion: string | undefined,
  releaseType: number | undefined,
): Candidate[] {
  switch (selection) {
    case "newest_by_file_date":
      return [...pool];
    case "newest_matching_game_version":
      return pool.filter((candidate) => candidate.gameVersions.includes(gameVersion as string));
    case "newest_with_release_type":
      return pool.filter((candidate) => candidate.releaseTypeRaw === releaseType);
    default: {
      const _exhaustive: never = selection;
      throw new CurseForgeError("ARGUMENT_REFUSED", `unhandled selection ${JSON.stringify(_exhaustive)}`, {
        detail: { selection: _exhaustive },
      });
    }
  }
}

function describeFilter(selection: Selection, gameVersion: string | undefined, releaseType: number | undefined): string {
  switch (selection) {
    case "newest_by_file_date":
      return "none — every candidate file was considered, then ordered by fileDate descending.";
    case "newest_matching_game_version":
      return (
        `gameVersions must contain ${JSON.stringify(gameVersion)}, then ordered by fileDate descending. ` +
        `Whether ASA mods populate game version fields at all is unverified (ADR-002 §14.3 U9), so an empty ` +
        `result here may be a capability gap rather than an absence of matching files.`
      );
    case "newest_with_release_type":
      return (
        `releaseType must equal the raw integer ${String(releaseType)}, then ordered by fileDate descending. ` +
        `That integer's meaning is YOUR claim, not this server's: no value table is published (U7).`
      );
    default: {
      const _exhaustive: never = selection;
      return _exhaustive;
    }
  }
}

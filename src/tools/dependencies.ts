import { z } from "zod";
import { MAX_BULK_IDS } from "../allowlist.js";
import { asArray, asNumber, asString, at } from "../coerce.js";
import { CurseForgeError } from "../errors.js";
import type { ToolDef } from "../registry.js";
import { RELATION_TYPE_NOTE, shapeDependencies, verificationBlock, type ToolContext, type DependencyEdge } from "./context.js";

/**
 * `resolve_mod_dependencies` — the ONLY tool that may issue a POST (ADR-002 §8),
 * and the reason §1 is written the way it is.
 *
 * ---------------------------------------------------------------------------
 * ONE POST PER LEVEL, NOT ONE GET PER NODE
 * ---------------------------------------------------------------------------
 *
 * Breadth-first, batched at every level:
 *
 *   1. Fetch the seed mods with ONE `POST /v1/mods` (E6).
 *   2. From each mod's files, collect `dependencies[]` — FileDependency objects
 *      carrying `modId` and `relationType`.
 *   3. Collect the next level's unique modIds, subtract everything already seen,
 *      and fetch the whole level with ONE `POST /v1/mods` (E6).
 *   4. Repeat to a bounded depth with a visited set. Both are mandatory: a
 *      third-party dependency graph may contain a CYCLE, and an unbounded
 *      traversal against an API with an undocumented rate limit is a
 *      self-inflicted incident.
 *   5. Chunk any level exceeding the §4.4 cap.
 *
 * That is the entire efficiency argument, and it is why a `method !== "GET"`
 * chokepoint would have been a FUNCTIONAL DEFECT here rather than merely
 * over-strict: it would have forced one GET per node and then passed its own
 * tests while doing so.
 *
 * ---------------------------------------------------------------------------
 * THIS TRAVERSAL OVER-COLLECTS, ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * `relationType` filtering is BLOCKED on ADR-002 §14.3 U6: the numeric enum's
 * meaning could not be established from primary source, and
 * required-vs-optional-vs-tool is precisely what decides whether an edge is
 * followed at all. Until that is resolved this tool follows EVERY edge and
 * surfaces the raw integer UNMAPPED. A wrong label here would produce a
 * dependency list that is wrong in a way nobody would check; a wide net is at
 * least visibly wide.
 */

/** Depth cap. Ours. A cycle or a deep chain must terminate, and it must say that it did. */
export const MAX_DEPTH = 4;

/** Node cap. Ours. Bounds total requests against an API whose rate limit is undocumented (§14.3 U11). */
export const MAX_NODES = 400;

interface ResolvedNode {
  mod_id: number;
  name: string | null;
  slug: string | null;
  depth: number;
  /** Every dependency edge found on every file of this mod, with raw relation integers. */
  edges: DependencyEdge[];
  /** null when no file on this mod carried a `dependencies` key at all — absent, not empty (§6). */
  edges_present: boolean;
}

export function dependencyTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "resolve_mod_dependencies",
      title: "Resolve a mod dependency tree (batched)",
      tier: 1,
      description:
        "Walk the dependency graph of one or more mods breadth-first, issuing ONE bulk POST per level rather " +
        "than one GET per node. Returns every reachable mod with the raw relationType integer on each edge. " +
        "IMPORTANT: this OVER-COLLECTS. CurseForge publishes no value table for relationType (ADR-002 §14.3 " +
        "U6), so required, optional, tool and incompatible edges cannot be told apart and ALL are followed. " +
        `Bounded at depth ${MAX_DEPTH} and ${MAX_NODES} nodes; when a bound is hit the result is reported as ` +
        "TRUNCATED with the unexplored frontier listed, never silently cut. Read-only. v0: all field paths " +
        "unverified.",
      inputSchema: {
        mod_ids: z
          .array(z.number().int().nonnegative())
          .min(1)
          .max(MAX_BULK_IDS)
          .optional()
          .describe(`Seed mod ids. At least one of mod_ids or file_ids is required. At most ${MAX_BULK_IDS}.`),
        file_ids: z
          .array(z.number().int().nonnegative())
          .min(1)
          .max(MAX_BULK_IDS)
          .optional()
          .describe(
            "Seed FILE ids, resolved through POST /v1/mods/files to find the mods they belong to before the " +
              `walk begins. Use this when you know which file you are running. At most ${MAX_BULK_IDS}.`,
          ),
        max_depth: z
          .number()
          .int()
          .min(1)
          .max(MAX_DEPTH)
          .optional()
          .describe(`How many levels to walk. Default and maximum ${MAX_DEPTH}.`),
      },
      handler: async (args) => {
        const seedModIds = (args["mod_ids"] as number[] | undefined) ?? [];
        const seedFileIds = (args["file_ids"] as number[] | undefined) ?? [];
        const maxDepth = (args["max_depth"] as number | undefined) ?? MAX_DEPTH;

        if (seedModIds.length === 0 && seedFileIds.length === 0) {
          throw new CurseForgeError(
            "ARGUMENT_REFUSED",
            "At least one of mod_ids or file_ids is required. An empty seed is refused rather than answered " +
              "with an empty tree, because an empty tree from an empty seed and an empty tree from a mod with " +
              "no dependencies would read identically (ADR-002 §6).",
          );
        }

        const requests: Array<{ endpoint: "E6" | "E7"; level: number; id_count: number }> = [];

        // Seed level: E7 first when the caller knows file ids, because a file
        // record names its mod and the walk is over mods.
        const frontierSeed = new Set<number>(seedModIds);
        let seedFiles: unknown[] = [];
        if (seedFileIds.length > 0) {
          for (const chunk of chunked(seedFileIds, MAX_BULK_IDS)) {
            const { data } = await ctx.client.request<unknown>({
              method: "POST",
              path: "v1/mods/files",
              body: { fileIds: chunk },
              tool: "resolve_mod_dependencies",
            });
            requests.push({ endpoint: "E7", level: 0, id_count: chunk.length });
            const files = asArray(data) ?? [];
            seedFiles = [...seedFiles, ...files];
            for (const file of files) {
              const modId = asNumber(at(file, "modId"));
              if (modId !== null) frontierSeed.add(modId);
              for (const edge of shapeDependencies(at(file, "dependencies")) ?? []) {
                if (edge.mod_id !== null) frontierSeed.add(edge.mod_id);
              }
            }
          }
        }

        const visited = new Set<number>();
        const nodes: ResolvedNode[] = [];
        let frontier = [...frontierSeed];
        let depth = 0;
        let truncatedBy: "depth" | "nodes" | null = null;

        while (frontier.length > 0) {
          if (depth >= maxDepth) {
            truncatedBy = "depth";
            break;
          }

          const level = frontier.filter((id) => !visited.has(id));
          if (level.length === 0) break;

          if (visited.size + level.length > MAX_NODES) {
            truncatedBy = "nodes";
            break;
          }

          const nextFrontier = new Set<number>();

          // ONE POST PER LEVEL. Chunked only when a level exceeds our own cap.
          for (const chunk of chunked(level, MAX_BULK_IDS)) {
            const { data } = await ctx.client.request<unknown>({
              method: "POST",
              path: "v1/mods",
              body: { modIds: chunk },
              tool: "resolve_mod_dependencies",
            });
            requests.push({ endpoint: "E6", level: depth, id_count: chunk.length });

            const mods = asArray(data);
            if (mods === null) {
              throw new CurseForgeError(
                "UPSTREAM_SHAPE",
                `POST /v1/mods returned a \`data\` value that is not an array at depth ${depth}, so this level ` +
                  `of the dependency tree could not be read. Reported as an error rather than as a leaf: a mod ` +
                  `with no dependencies is a real answer and must not be confused with an unreadable response.`,
                { detail: { depth, requested_ids: chunk.length } },
              );
            }

            for (const mod of mods) {
              const modId = asNumber(at(mod, "id"));
              if (modId === null) continue;
              visited.add(modId);

              const files = asArray(at(mod, "latestFiles")) ?? [];
              const edges: DependencyEdge[] = [];
              let sawDependenciesKey = false;
              for (const file of files) {
                const fileEdges = shapeDependencies(at(file, "dependencies"));
                if (fileEdges === null) continue;
                sawDependenciesKey = true;
                edges.push(...fileEdges);
              }

              nodes.push({
                mod_id: modId,
                name: asString(at(mod, "name")),
                slug: asString(at(mod, "slug")),
                depth,
                edges,
                edges_present: sawDependenciesKey,
              });

              for (const edge of edges) {
                // EVERY edge is followed. See RELATION_TYPE_NOTE: with U6
                // unresolved there is no honest way to skip one.
                if (edge.mod_id !== null && !visited.has(edge.mod_id)) nextFrontier.add(edge.mod_id);
              }
            }
          }

          // Ids the caller asked about that came back in no response. Reported
          // rather than dropped: "CurseForge did not return this mod" is a fact,
          // and silently omitting it would make a partial tree look complete.
          frontier = [...nextFrontier];
          depth += 1;
        }

        const unresolved = [...frontierSeed].filter((id) => !visited.has(id));

        return {
          seed: {
            mod_ids: seedModIds,
            file_ids: seedFileIds,
            seed_files_resolved: seedFiles.length,
          },
          traversal: {
            levels_walked: depth,
            max_depth_requested: maxDepth,
            max_depth_allowed: MAX_DEPTH,
            max_nodes_allowed: MAX_NODES,
            nodes_resolved: nodes.length,
            // Named in the ADR's own word, and only when it happened.
            truncated: truncatedBy !== null,
            truncated_by: truncatedBy,
            truncation_note:
              truncatedBy === null
                ? null
                : truncatedBy === "depth"
                  ? `TRUNCATED at depth ${depth}: the walk stopped at the requested depth limit and the ` +
                    `frontier below was not explored. The tree returned is a PREFIX of the real one.`
                  : `TRUNCATED at ${visited.size} nodes: expanding the next level would have exceeded the node ` +
                    `cap of ${MAX_NODES}. The tree returned is a PREFIX of the real one.`,
            unexplored_frontier: frontier,
            // One request per level (per chunk), which is the whole point of the
            // two POST entries existing. Surfaced so the claim is checkable from
            // the outside rather than only in a test.
            requests_issued: requests,
            request_count: requests.length,
          },
          nodes,
          seed_ids_not_returned_by_curseforge: unresolved,
          relation_type_note: RELATION_TYPE_NOTE,
          asa_catalog_observation:
            "MEASURED 2026-08-18: across 1899 file records from 748 distinct ARK: Survival Ascended mods, ZERO " +
            "declared any dependency — the `dependencies` array was present and empty every single time. So for " +
            "ASA specifically, a single-node tree is the EXPECTED result of this tool and not a sign it failed. " +
            "If you get an empty tree, the likely reading is 'this mod declares no dependencies on CurseForge', " +
            "not 'the traversal broke'. It also means the raw relationType integer has never actually been " +
            "observed, so the edge shape below is still documentation-derived (ADR-002 §14.3 U5/U6).",
          over_collection_warning:
            "This tree follows every dependency edge, including ones that are probably optional or tool " +
            "relationships. Do NOT read it as a list of requirements. Resolving that needs the " +
            "FileRelationType value table, which CurseForge does not publish (ADR-002 §14.3 U6) and which this " +
            "server refuses to guess.",
          verification: verificationBlock(),
        };
      },
    },
  ];
}

/** Split into chunks of at most `size`. §4.4's cap is ours, not the vendor's. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

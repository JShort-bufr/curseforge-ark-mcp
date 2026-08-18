import type { CurseForgeClient, PageDescriptor } from "../client.js";
import { asArray, asBool, asNumber, asString, at, describeCompleteness } from "../coerce.js";
import type { Config } from "../config.js";
import type { GameResolver } from "../game.js";

export interface ToolContext {
  client: CurseForgeClient;
  config: Config;
  /** Injected, not a module singleton (ADR-002 open question 5), so tests can supply one. */
  games: GameResolver;
}

/**
 * THE SENTENCE EVERY TOOL OUTPUT CARRIES.
 *
 * ADR-002 §13 ships this repo as v0 and gates the word "verified". Commit
 * 5481c04 in the sibling repo corrected THREE field paths that were wrong until
 * checked against live responses, in a repo whose fixtures were built the same
 * careful way these were. So every field below is read off a published schema
 * and none has been observed.
 *
 * This note is attached to tool output rather than only to the README because
 * the README is not in the model's context when it reads a result.
 */
export const V0_NOTE =
  "v0: every field path in this output is documentation-derived and UNVERIFIED. No authenticated CurseForge " +
  "call has ever been made from this repo. A null field may mean the API omitted it OR that this client reads " +
  "the wrong path (ADR-002 §14.3 U3/U4/U5). Run `npm run smoke` once a key exists to start falsifying that.";

/**
 * `FileReleaseType` is a bare integer and its meaning is NOT PUBLISHED.
 *
 * ADR-002 §14.3 U7: the docs page shows `releaseType` as an integer with no
 * value table. The Upload API uses the NAMES alpha/beta/release, which supports
 * the existence of the set and says nothing about which integer is which.
 *
 * So the integer is surfaced RAW AND UNMAPPED. Guessing 1=release would make the
 * output look finished and would silently recommend an alpha build as a stable
 * update — a wrong answer in exactly the place a wrong answer costs a game
 * server. The architect deliberately refused to supply a mapping from memory and
 * this repo will not invent one.
 */
export const RELEASE_TYPE_NOTE =
  "releaseType is surfaced as a RAW INTEGER and is deliberately NOT mapped to release/beta/alpha. CurseForge " +
  "publishes no value table for it (ADR-002 §14.3 U7). Do not assume 1 means release. If you need to filter on " +
  "release type, pass the integer you mean and state why you believe it.";

/**
 * `FileRelationType` is a bare integer and its meaning is NOT RESOLVED.
 *
 * ADR-002 §14.3 U6, after three attempts against the docs. This one is stronger
 * than U7 because it changes behaviour: required vs optional vs tool decides
 * whether an edge is FOLLOWED AT ALL. §7.2 therefore blocks on it, and the
 * traversal over-collects on purpose and says so.
 */
export const RELATION_TYPE_NOTE =
  "relationType is surfaced as a RAW INTEGER and is deliberately NOT mapped to required/optional/tool/" +
  "incompatible. CurseForge publishes no value table for it (ADR-002 §14.3 U6), so this traversal follows EVERY " +
  "edge rather than guessing which ones are required. The result therefore OVER-COLLECTS: some listed mods are " +
  "probably optional or tool relationships, not requirements. A wrong label here would produce a dependency " +
  "list that is wrong in a way nobody would check.";

/** A page block, with its completeness sentence, ready to drop into a tool result. */
export function pageBlock(page: PageDescriptor | null): Record<string, unknown> {
  const note = describeCompleteness(page);
  return {
    pagination: page,
    completeness_note: note,
    // Explicit boolean, required by §3: the model cannot reason about
    // completeness it was never told about, and `has_more` living only inside
    // the nested object is easy to skim past.
    more_results_exist: page?.has_more ?? null,
  };
}

/**
 * Shape a `Mod` record (ADR-002 §14.3 U3).
 *
 * Absent fields become `null`, never 0/""/[] — see src/coerce.ts. The raw record
 * is NOT passed through wholesale: an unfiltered third-party object in a model's
 * context is how `description` HTML written by a stranger arrives somewhere it
 * was never reviewed (§12.3), and this is a curation surface, not a proxy.
 */
export function shapeMod(mod: unknown): Record<string, unknown> {
  return {
    id: asNumber(at(mod, "id")),
    game_id: asNumber(at(mod, "gameId")),
    name: asString(at(mod, "name")),
    slug: asString(at(mod, "slug")),
    date_modified: asString(at(mod, "dateModified")),
    website_url: asString(at(mod, "links", "websiteUrl")),
    /**
     * Surfaced as a count plus the raw ids, not as a taxonomy. `GET /v1/categories`
     * is deferred (§1.7) and no allow-list entry was added for it, so this client
     * cannot name a category — only report that the mod claims some.
     */
    categories_raw: (asArray(at(mod, "categories")) ?? []).map((category) => ({
      id: asNumber(at(category, "id")),
      name: asString(at(category, "name")),
    })),
    categories_note:
      "Category/class taxonomy is DEFERRED (DEC-002 §11.2). GET /v1/categories is not on the allow-list, so " +
      "these are whatever the mod record carried and nothing resolves them.",
    allow_mod_distribution: asBool(at(mod, "allowModDistribution")),
    latest_files: (asArray(at(mod, "latestFiles")) ?? []).map(shapeFile),
    latest_files_indexes: asArray(at(mod, "latestFilesIndexes")),
    unverified: V0_NOTE,
  };
}

/**
 * Shape a `File` record (ADR-002 §14.3 U4).
 *
 * `dependencies` is preserved as edges with the raw relation integer (U6).
 */
export function shapeFile(file: unknown): Record<string, unknown> {
  return {
    id: asNumber(at(file, "id")),
    mod_id: asNumber(at(file, "modId")),
    display_name: asString(at(file, "displayName")),
    file_name: asString(at(file, "fileName")),
    file_date: asString(at(file, "fileDate")),
    is_available: asBool(at(file, "isAvailable")),
    game_versions: asArray(at(file, "gameVersions")),
    sortable_game_versions: asArray(at(file, "sortableGameVersions")),
    release_type_raw: asNumber(at(file, "releaseType")),
    release_type_note: RELEASE_TYPE_NOTE,
    dependencies: shapeDependencies(at(file, "dependencies")),
    unverified: V0_NOTE,
  };
}

/** One `FileDependency` edge (§14.3 U5), with the relation integer left unmapped (U6). */
export interface DependencyEdge {
  mod_id: number | null;
  relation_type_raw: number | null;
}

export function shapeDependencies(raw: unknown): DependencyEdge[] | null {
  const list = asArray(raw);
  // null, not [] — "the response did not carry a dependencies field" is a
  // different fact from "this file declares no dependencies", and §14.3 U9 makes
  // telling them apart the whole point: an always-empty field is a capability
  // gap, not a bug.
  if (list === null) return null;
  return list.map((edge) => ({
    mod_id: asNumber(at(edge, "modId")),
    relation_type_raw: asNumber(at(edge, "relationType")),
  }));
}

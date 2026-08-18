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
 * THE VERIFICATION SENTENCE EVERY TOOL OUTPUT CARRIES.
 *
 * AMENDED 2026-08-18 by office-backend-engineer, after the first authenticated
 * run (ADR-002 §13.5 phase 6). The previous text said "No authenticated
 * CurseForge call has ever been made from this repo" and appeared 32 times in a
 * single smoke run. That is now FALSE, and a false disclaimer is worse than none:
 * it trains a reader to skip the disclaimer that is still true.
 *
 * What replaced it is narrower on purpose. Some rows resolved; several did not,
 * and the repo does NOT flip to "verified" because the easy ones landed.
 *
 * The long form lives once per tool result (see `verificationBlock`). The short
 * form below rides on every record, because it is repeated dozens of times per
 * conversation and a 500-character caveat repeated 32 times is how a caveat gets
 * skimmed.
 */
export const FIELD_PATH_NOTE =
  "Mod/File field paths confirmed against live responses 2026-08-18. Still unconfirmed: the FileDependency " +
  "shape, and the meaning of the releaseType/relationType integers — both surfaced raw, never mapped.";

/**
 * The long form, carried once per tool result.
 *
 * Numbers rather than adjectives: a reader deciding how much to trust this needs
 * the sample size, not the word "extensive".
 */
export const VERIFICATION_BLOCK = {
  stage: "v0.2 — partially verified",
  field_paths_confirmed_live_on: "2026-08-18",
  sample: "748 distinct ARK: Survival Ascended mods, 1899 file records",
  confirmed:
    "Every Mod and File path this client reads was present and correctly typed in live responses: Mod " +
    "id/gameId/name/slug/dateModified/links.websiteUrl/categories/allowModDistribution/latestFiles/" +
    "latestFilesIndexes, and File id/modId/displayName/fileName/fileDate/isAvailable/gameVersions/" +
    "sortableGameVersions/releaseType/dependencies. No field path needed correcting.",
  still_unconfirmed:
    "The FileDependency shape { modId, relationType } was NEVER observed: 0 of 1899 sampled ASA files " +
    "declared a dependency, with the `dependencies` key present and empty every time. So the traversal's " +
    "edge shape is still documentation-derived, and the FileRelationType integers remain both unpublished " +
    "AND unobserved. FileReleaseType integers 1, 2 and 3 have now been SEEN (1893/3/3 occurrences), which " +
    "establishes that the set has at least three members and establishes NOTHING about which integer means " +
    "release, beta or alpha.",
  register: "docs/adr/ADR-002-endpoint-allow-list.md §14.3, and the README's unverified table",
} as const;

/** The long-form block, for the top level of a tool result. */
export function verificationBlock(): Record<string, unknown> {
  return { ...VERIFICATION_BLOCK };
}

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
  "release type, pass the integer you mean and state why you believe it. OBSERVED LIVE 2026-08-18 across 1899 " +
  "ASA files: 1 (1893 files), 2 (3) and 3 (3). That establishes the set has at least three members and " +
  "establishes NOTHING about which is release, beta or alpha — a frequency distribution is not a value table, " +
  "and inferring 1=release because 1 is commonest is precisely the guess this repo refuses to make.";

/**
 * `FileRelationType` is a bare integer and its meaning is NOT RESOLVED.
 *
 * ADR-002 §14.3 U6, after three attempts against the docs. This one is stronger
 * than U7 because it changes behaviour: required vs optional vs tool decides
 * whether an edge is FOLLOWED AT ALL. §7.2 therefore blocks on it, and the
 * traversal over-collects on purpose and says so.
 *
 * AMENDED 2026-08-18: it is now worse than unpublished, it is UNOBSERVABLE in
 * this catalog. A 1899-file sample across 748 ASA mods produced ZERO dependency
 * edges — `dependencies` was present and empty every single time. ADR-002's own
 * risk register anticipated this ("U6 may not be resolvable even with a key"),
 * and named the consequence: the unmapped-integer behaviour is THE ANSWER, not a
 * stopgap. Nothing here changes; the reason it does not change is now evidence
 * rather than caution.
 */
export const RELATION_TYPE_NOTE =
  "relationType is surfaced as a RAW INTEGER and is deliberately NOT mapped to required/optional/tool/" +
  "incompatible. CurseForge publishes no value table for it (ADR-002 §14.3 U6), so this traversal follows EVERY " +
  "edge rather than guessing which ones are required. The result therefore OVER-COLLECTS: some listed mods are " +
  "probably optional or tool relationships, not requirements. A wrong label here would produce a dependency " +
  "list that is wrong in a way nobody would check. OBSERVED LIVE 2026-08-18: no relationType integer has ever " +
  "been seen, because no ASA file in a 1899-file sample declared any dependency at all.";

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
    field_paths: FIELD_PATH_NOTE,
  };
}

/**
 * Shape a `File` record (ADR-002 §14.3 U4).
 *
 * `dependencies` is preserved as edges with the raw relation integer (U6).
 *
 * WHAT THIS FUNCTION OMITS IS NOW LOAD-BEARING. Observed live 2026-08-18: a real
 * File record carries a `downloadUrl` field, populated. ADR-002 §1.7 keeps the
 * download-url ENDPOINT off the allow-list, which was the whole control as
 * written — but the URL arrives anyway, inside every file record, on endpoints
 * that ARE allowed. So the endpoint exclusion alone does not deliver DEC-002
 * §11.3's "no download or install"; this allow-list-shaped shaper is the other
 * half, and passing a raw file record through would defeat it. There is a test
 * whose fixture CONTAINS a downloadUrl specifically to prove it does not survive.
 *
 * Also omitted, for the same reason but lower stakes: fileStatus, hashes,
 * fileLength, downloadCount, fileSizeOnDisk, alternateFileId, isServerPack,
 * fileFingerprint, modules, cookingInfo. All real, none needed by v1's seven
 * tools, and each one is context a model would have to read past.
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
    field_paths: FIELD_PATH_NOTE,
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

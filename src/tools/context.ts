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
  "Mod/File field paths confirmed against live responses 2026-08-18 (summary/status/dates/authors/fileLength " +
  "re-confirmed present 2026-08-19). Still unconfirmed: the FileDependency " +
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
    "id/gameId/name/slug/summary/status/dateCreated/dateModified/dateReleased/links.websiteUrl/authors/" +
    "categories/allowModDistribution/isAvailable/latestFiles/latestFilesIndexes, and File id/modId/" +
    "displayName/fileName/fileDate/fileLength/isAvailable/gameVersions/sortableGameVersions/releaseType/" +
    "dependencies. No field path needed correcting.",
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

/**
 * A catalog row is not an install recommendation.
 *
 * Founder 2026-08-19: ranking by popularity recommended Admin Panel (id 929868)
 * as a gameplay pick. Live record: status 4, isAvailable true, summary "Admin
 * Panel Tool", allowModDistribution false — the same shape as currently updated
 * content packs. What distinguished it was the remaining files: four zips named
 * "* 98.zip" dated 2025-11-06, fileLength 6888 bytes. Real ASA packs in the same
 * sample were megabytes to hundreds of megabytes. The API does not say "removed";
 * the published file list does. This note rides once per tool result so a model
 * cannot treat name + download rank as sufficient.
 */
export const CURATION_NOTE =
  "A search hit or mod record is a catalog row, not an install recommendation. Before treating a mod as " +
  "usable, inspect latest_files / the file list: file_name and file_length_bytes. ASA content packs are " +
  "typically megabytes to hundreds of megabytes; a few kilobytes is still a published file — this server " +
  "does not open archives and does not guess that a small zip is a stub. allow_mod_distribution false is " +
  "common on popular ASA mods and is NOT 'removed from CurseForge'. status_raw is an unmapped integer; " +
  "observed live 2026-08-19: 4 on both an actively updated pack and a project whose only remaining files " +
  "were 6.8KB placeholders. summary is the author's short plain-text blurb, not the HTML description.";

/**
 * The two-MCP collaboration, said once so a search result cannot be mistaken
 * for an install. Founder 2026-08-19: CurseForge screens, Nitrado installs.
 * Embodiment is an in-game player agent (Steam / autonomous ASA character), not
 * a UI that calls both servers. Neither server holds the other's credential
 * (DEC-002 Ruling 1 / ADR-002 §9). `set_active_mods` remains queued (DEC-002 A6).
 */
export const HANDOFF_NOTE =
  "This server screens CurseForge mods. It does not install them. Pass curseforge_mod_ids to the sibling " +
  "nitrado-ark-mcp in the same conversation — nitrado-ark answers which ids are in active-mods; writing " +
  "that setting is still queued (DEC-002 A6) and is a Nitrado restart. Neither MCP holds the other's " +
  "credential. This is catalog/install infrastructure, not an in-game player agent.";

export function shapeCategory(category: unknown): Record<string, unknown> {
  return {
    id: asNumber(at(category, "id")),
    game_id: asNumber(at(category, "gameId")),
    name: asString(at(category, "name")),
    slug: asString(at(category, "slug")),
    url: asString(at(category, "url")),
    is_class: asBool(at(category, "isClass")),
    class_id: asNumber(at(category, "classId")),
    parent_category_id: asNumber(at(category, "parentCategoryId")),
    display_index: asNumber(at(category, "displayIndex")),
  };
}

/** Category ids a raw Mod record claims. Used to apply exclude_category_ids locally. */
export function rawModCategoryIds(mod: unknown): number[] {
  const list = asArray(at(mod, "categories"));
  if (list === null) return [];
  const ids: number[] = [];
  for (const category of list) {
    const id = asNumber(at(category, "id"));
    if (id !== null) ids.push(id);
  }
  return ids;
}

/** Author summary is short in this catalog; bound it so a future long value cannot flood context. */
export const SUMMARY_MAX_CHARS = 1000;

export function boundedSummary(value: unknown): { summary: string | null; summary_truncated: boolean | null } {
  const raw = asString(value);
  if (raw === null) return { summary: null, summary_truncated: null };
  if (raw.length <= SUMMARY_MAX_CHARS) return { summary: raw, summary_truncated: false };
  return { summary: raw.slice(0, SUMMARY_MAX_CHARS), summary_truncated: true };
}

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
  const authors = asArray(at(mod, "authors"));
  const { summary, summary_truncated } = boundedSummary(at(mod, "summary"));
  return {
    id: asNumber(at(mod, "id")),
    game_id: asNumber(at(mod, "gameId")),
    name: asString(at(mod, "name")),
    slug: asString(at(mod, "slug")),
    summary,
    summary_truncated,
    status_raw: asNumber(at(mod, "status")),
    date_created: asString(at(mod, "dateCreated")),
    date_modified: asString(at(mod, "dateModified")),
    date_released: asString(at(mod, "dateReleased")),
    website_url: asString(at(mod, "links", "websiteUrl")),
    authors:
      authors === null
        ? null
        : authors.map((author) => ({
            name: asString(at(author, "name")),
            url: asString(at(author, "url")),
          })),
    /**
     * Surfaced as ids plus names from the mod record. Canonical taxonomy for the
     * game is `list_categories` (E8). Search can include or exclude by those ids.
     */
    categories_raw: (asArray(at(mod, "categories")) ?? []).map((category) => ({
      id: asNumber(at(category, "id")),
      name: asString(at(category, "name")),
    })),
    categories_note:
      "Category names on a mod record are whatever that record carried. Canonical class/category ids for " +
      "this game come from list_categories (GET /v1/categories), not from guessing.",
    allow_mod_distribution: asBool(at(mod, "allowModDistribution")),
    is_available: asBool(at(mod, "isAvailable")),
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
 * downloadCount, fileSizeOnDisk, alternateFileId, isServerPack,
 * fileFingerprint, modules, cookingInfo. All real. `fileLength` was in this
 * list until 2026-08-19: a yanked project kept status/isAvailable looking
 * identical to a live pack, and the remaining files were 6888 bytes. Length
 * is now a curation field, not clutter.
 */
export function shapeFile(file: unknown): Record<string, unknown> {
  return {
    id: asNumber(at(file, "id")),
    mod_id: asNumber(at(file, "modId")),
    display_name: asString(at(file, "displayName")),
    file_name: asString(at(file, "fileName")),
    file_date: asString(at(file, "fileDate")),
    file_length_bytes: asNumber(at(file, "fileLength")),
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

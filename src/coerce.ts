import type { PageDescriptor } from "./client.js";
import { MAX_ADDRESSABLE_RESULTS } from "./allowlist.js";

/**
 * EMPTY IS NOT UNKNOWN (ADR-002 §6).
 *
 * Three states, never conflated:
 *
 *   Empty    the API answered and the answer is "none"  →  [] / 0, with the query echoed
 *   Absent   the field was not in the response          →  null, NEVER 0, "" or []
 *   Unknown  the request did not complete, or the shape was wrong  →  an error, never a value
 *
 * Concretely for this API: `data: []` from search_mods means no mods matched — a
 * real answer. `latestFiles: []` on a mod means the mod has no published files —
 * also a real answer, and materially different from get_latest_file having
 * failed. A mod field missing from the response is null, and null must not be
 * rendered to the model as a zero or an empty string.
 *
 * Everything below is deliberately less forgiving than the sibling repo's
 * equivalent. Nitrado is stringly-typed and returns booleans as "true"/"false";
 * CurseForge's published schema is properly typed. So a string where a number
 * belongs is NOT coerced here — it is a signal that a field path is wrong, and
 * every field path in this repo is a hypothesis (§13). Coercing would hide
 * exactly the evidence the smoke probe exists to collect.
 */

/** Returns null (not false) for absent or non-boolean input. No string coercion — see the module note. */
export function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Returns null (not 0) for absent, non-numeric, or non-finite input. */
export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Returns null (not "") for absent input. Preserves an intentional empty string. */
export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Returns null (not []) when the field is absent, and the array when it is
 * present — INCLUDING when it is empty.
 *
 * The distinction is the whole of §6 in one function: `[]` means the API said
 * "none", `null` means the API did not say. `dependencies: []` on a mod file is
 * "this file declares no dependencies"; a missing `dependencies` key is "this
 * response does not carry that field", which for this repo is also a hint that
 * the field path may be wrong (§14.3 U9).
 */
export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Safe property read on an unknown-shaped upstream object. */
export function prop(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

/** Safe nested read, e.g. at(mod, "links", "websiteUrl"). */
export function at(source: unknown, ...keys: readonly string[]): unknown {
  let current: unknown = source;
  for (const key of keys) {
    current = prop(current, key);
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Say, in words, how complete a paginated answer is (ADR-002 §3, §4.3).
 *
 * Returns null when the page is complete and nothing needs saying — an
 * unconditional note trains the reader to skip it, and then the important one
 * goes unread. The sibling repo's `describeBuild` makes the same choice for the
 * same reason.
 *
 * The `tail_unreachable` wording is required rather than stylistic: a result set
 * larger than the API's own addressable window is a fact about the API, and
 * hiding it produces a search the model believes it exhausted.
 */
export function describeCompleteness(page: PageDescriptor | null): string | null {
  if (page === null) return null;

  if (page.tail_unreachable === true) {
    return (
      `THE TAIL OF THIS RESULT SET IS UNREACHABLE. totalCount is ${String(page.total_count)}, which exceeds ` +
      `CurseForge's addressable window of ${MAX_ADDRESSABLE_RESULTS} results (index + pageSize <= ` +
      `${MAX_ADDRESSABLE_RESULTS}). Paging cannot reach the remainder no matter how many calls are made. ` +
      `Narrow the filter — a more specific search term or sort order — rather than paging further. Do NOT ` +
      `treat a page from this set as an exhaustive answer.`
    );
  }

  if (page.has_more === true) {
    return (
      `More results exist beyond this page: index ${String(page.index)} + resultCount ` +
      `${String(page.result_count)} is less than totalCount ${String(page.total_count)}. Page forward by ` +
      `raising index. This page is NOT the whole set.`
    );
  }

  if (page.has_more === null) {
    return (
      `Whether more results exist could not be determined: CurseForge's pagination object did not carry all ` +
      `of index, resultCount and totalCount as numbers. Treat completeness as UNKNOWN rather than assuming ` +
      `this is the whole set.`
    );
  }

  return null;
}

import { CurseForgeError } from "./errors.js";

/**
 * THE ENDPOINT ALLOW-LIST.
 *
 * ADR-002 §1 lives in this file. It is the security property of this repo, and
 * adding an entry is the reviewable act.
 *
 * ---------------------------------------------------------------------------
 * Why this is an allow-list and NOT the sibling repo's method check
 * ---------------------------------------------------------------------------
 *
 * `nitrado-ark-mcp` enforces read-only at the transport with, in effect,
 * `method !== "GET" → refuse`. Copying that here fails in the most expensive
 * possible way: IT WORKS. It refuses things, it passes its own tests, and it
 * silently makes the server bad at its job — because CurseForge uses POST to
 * READ. `POST /v1/mods` and `POST /v1/mods/files` are bulk retrievals, and
 * without them `resolve_mod_dependencies` walks a dependency tree one GET per
 * node against a paginated third-party API with an undocumented rate limit.
 *
 * The obvious fix is worse than the bug. Relax the check to `{GET, POST}` and
 * the arithmetic is:
 *
 *     allowed = { GET }         → the batch reads are refused (broken, loudly)
 *     allowed = { GET, POST }   → every request this client can construct is allowed
 *
 * The documented catalog API contains only GET and POST. A gate admitting both
 * admits everything, while continuing to look present, and the existing tests
 * still pass because they were written against a gate that refuses DELETE and it
 * still refuses DELETE.
 *
 * So the test is inverted. EVERY outbound request must match an explicit entry
 * below. An unmatched request is REFUSED BEFORE THE REQUEST IS BUILT — not
 * logged and sent, not warned about.
 *
 *     THE FAILURE MODE IS "UNMATCHED REQUEST REFUSED", NEVER "UNRECOGNISED
 *     REQUEST SENT".
 *
 * What this buys that a method check cannot: CurseForge documents a MUTATING
 * upload API — a multipart POST to /api/projects/{id}/upload-file, on a
 * different host, authenticated with a different header (§14.2). Under
 * `{GET, POST}` nothing about that request's method distinguishes it from
 * `POST /v1/mods`. Under this list it has no entry, and the host pin refuses it
 * a second time for an independent reason.
 *
 * The read-only property of this server is therefore a property of THIS LIST,
 * not an inherited property of CurseForge's current endpoint inventory.
 */

/** Only the two methods the documented catalog API uses. Nothing else is spellable. */
export type HttpMethod = "GET" | "POST";

/**
 * THE PINNED ORIGIN (ADR-002 §1.6).
 *
 * A request to any other host is refused at the transport regardless of path.
 * This is an ALLOW of one host, not a deny of a named other — the upload host
 * from §14.2 is deliberately not named here, because it was not confirmed and
 * because naming it would make this a deny-list, which is the direction this
 * whole file rejects.
 *
 * UNVERIFIED (§14.3 U13): documentation-derived. Nobody here has called it.
 */
export const PINNED_ORIGIN = "https://api.curseforge.com";

/**
 * Our own cap on bulk-read body length (ADR-002 §4.4).
 *
 * OURS, NOT THE VENDOR'S. No id-count cap is documented for POST /v1/mods or
 * POST /v1/mods/files and none has been observed (§14.3 U10). An unbounded body
 * against an API with an unknown rate limit is a self-inflicted incident, so
 * callers above this chunk instead.
 */
export const MAX_BULK_IDS = 200;

/** Documented: "The maximum page size is 50 results per page". Confirmed on primary source (§4). */
export const MAX_PAGE_SIZE = 50;

/** Documented: "capped at 10000 total results ... (index + pageSize <= 10,000)". Confirmed (§4). */
export const MAX_ADDRESSABLE_RESULTS = 10_000;

/**
 * One authorised endpoint.
 *
 * `pattern` is anchored at both ends and its id segments bind to `[0-9]+`. Use
 * `numericPath()` rather than hand-rolling one; every hand-rolled RegExp is a
 * chance to forget an anchor.
 */
export interface EndpointEntry {
  /** The ADR's own label, so an error message and a review comment can name the same thing. */
  id: "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7";
  method: HttpMethod;
  /** Anchored, with id segments bound to digits. Matched against the NORMALIZED path. */
  pattern: RegExp;
  /** Human-readable form, for error messages and diagnostics. */
  shape: string;
  /** Which tools this serves. Documentation, not enforcement. */
  serves: string;
  /**
   * Paginated endpoints MUST return a `pagination` object; its absence is an
   * error rather than an assumed single page (ADR-002 §3). Assuming one page is
   * how a tool reports 50 of 900 mods as if it were all of them.
   */
  paginated: boolean;
  /**
   * The single key a bulk-read body may carry, or null for the GET entries.
   *
   * Only E6 and E7 may carry a body at all. A body on a GET entry is a
   * programming error and is refused, not dropped.
   */
  bodyKey: string | null;
}

/**
 * Build an anchored path pattern whose id segments are DIGITS ONLY.
 *
 * `[0-9]+` and not `[^/]+`, and this is the load-bearing mechanical requirement
 * of §1.6 rather than a style preference. `/v1/mods/search` and
 * `/v1/mods/{modId}` are siblings. A permissive `{modId}` makes E3 match
 * `/v1/mods/search`, `/v1/mods/anything`, and — with a lax separator — a good
 * deal more. Numeric-only id segments make the E2/E3 ambiguity STRUCTURALLY
 * IMPOSSIBLE rather than dependent on match ordering.
 *
 * Ordering is still pinned deterministically (first match wins, entries in ADR
 * order) so that a future entry cannot shadow an existing one by accident — but
 * correctness here does not rest on it.
 */
function numericPath(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withIds = escaped.replace(/\\\{[a-zA-Z]+\\\}/g, "[0-9]+");
  return new RegExp(`^${withIds}$`);
}

/**
 * THE SEVEN ENTRIES (ADR-002 §1.6). The complete set for v1.
 *
 * Order is the ADR's order and is matched first-to-last.
 *
 * What is deliberately NOT here, because an allow-list's exclusions are as much
 * a decision as its entries (§1.7):
 *
 *   GET /v1/mods/{modId}/files/{fileId}/download-url
 *       Refused outright by DEC-002 §11.3 — no download or install tool.
 *       It is a documented READ, a GET, on the pinned host, and it is refused
 *       purely because it is not on this list. That test is the acceptance test
 *       for "this is an allow-list and not a method check".
 *   GET/POST /v1/fingerprints, /v1/fingerprints/fuzzy   deferred (§11.2)
 *   POST /v1/mods/featured                              deferred; a read POST, still not listed
 *   GET /v1/categories                                  deferred (categories / classId taxonomy)
 *   GET /v1/games/{gameId} and its versions endpoints   not needed; E1 suffices for §5
 *   GET /v1/mods/{modId}/description, .../changelog     not needed, and attacker-authorable free text
 *   /v1/minecraft/*                                     wrong game
 */
export const ENDPOINT_ALLOWLIST: readonly EndpointEntry[] = [
  {
    id: "E1",
    method: "GET",
    pattern: numericPath("v1/games"),
    shape: "GET /v1/games",
    serves: "capability detection (§5), get_api_diagnostics",
    paginated: true,
    bodyKey: null,
  },
  {
    id: "E2",
    method: "GET",
    pattern: numericPath("v1/mods/search"),
    shape: "GET /v1/mods/search",
    serves: "search_mods",
    paginated: true,
    bodyKey: null,
  },
  {
    id: "E3",
    method: "GET",
    pattern: numericPath("v1/mods/{modId}"),
    shape: "GET /v1/mods/{modId}",
    serves: "get_mod, get_latest_file",
    paginated: false,
    bodyKey: null,
  },
  {
    id: "E4",
    method: "GET",
    pattern: numericPath("v1/mods/{modId}/files"),
    shape: "GET /v1/mods/{modId}/files",
    serves: "list_mod_files, get_latest_file",
    paginated: true,
    bodyKey: null,
  },
  {
    id: "E5",
    method: "GET",
    pattern: numericPath("v1/mods/{modId}/files/{fileId}"),
    shape: "GET /v1/mods/{modId}/files/{fileId}",
    serves: "get_mod_file",
    paginated: false,
    bodyKey: null,
  },
  {
    id: "E6",
    method: "POST",
    pattern: numericPath("v1/mods"),
    shape: "POST /v1/mods (bulk read, body = { modIds: number[] })",
    serves: "resolve_mod_dependencies",
    paginated: false,
    bodyKey: "modIds",
  },
  {
    id: "E7",
    method: "POST",
    pattern: numericPath("v1/mods/files"),
    shape: "POST /v1/mods/files (bulk read, body = { fileIds: number[] })",
    serves: "resolve_mod_dependencies",
    paginated: false,
    bodyKey: "fileIds",
  },
];

/**
 * The one tool permitted to reach a POST entry (ADR-002 §8).
 *
 * Stated as data rather than prose so a test can assert it: exactly two entries
 * carry POST, and exactly one tool may use them. A future tool wanting a bulk
 * read is a review, not a convenience.
 */
export const POST_CAPABLE_TOOLS: readonly string[] = ["resolve_mod_dependencies"];

/**
 * ONE NORMALIZATION, before the check, and the URL is built from ITS OUTPUT.
 *
 * Ported in effect from ADR-001 §1 as amended in the sibling repo. The amendment
 * exists because the original was insufficient and `%252e%252e` is the case that
 * broke it. Do not re-derive this; do not weaken it on the grounds that this
 * transport only reads.
 *
 * The rules, and why each is here:
 *
 *   - Leading separators stripped, so `/v1/games` and `v1/games` are not two
 *     different security decisions.
 *   - Backslashes folded to `/`. This runs on Windows; a `..\` that only a
 *     Windows path resolver understands must not survive a check written in `/`.
 *   - Percent-decoded EXACTLY ONCE. Once, not to a fixed point: decoding to a
 *     fixed point invents a string nobody sent, and the wire form is what the
 *     upstream router acts on.
 *   - `.`, `..` and empty segments are REFUSED, not resolved. Resolving is a
 *     second normalization, and there is only one.
 *   - NO `%` SURVIVES. This is the subtle one. `%252e%252e` decodes once to
 *     `%2e%2e`, which contains no literal `..` for a segment check to catch, but
 *     the WHATWG URL parser treats `%2e` as a dot segment during path
 *     resolution — so `new URL()` would resolve it to `..` AFTER our checks
 *     approved it. Every path this server sends is built from literals plus
 *     numeric ids; nothing legitimate needs an escape.
 */
export function normalizePath(rawPath: string): string {
  const refuse = (reason: string): never => {
    throw new CurseForgeError("PATH_REFUSED", `Refused path ${JSON.stringify(clip(rawPath))}. ${reason}`, {
      detail: { path: clip(rawPath) },
    });
  };

  const stripped = rawPath.trim().replace(/^[/\\]+/, "");
  if (stripped === "") return refuse("It is empty once leading separators are removed.");

  let decoded: string;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    return refuse("It is not valid percent-encoding, so it cannot be normalized before the safety checks run.");
  }

  const unified = decoded.replace(/\\/g, "/");

  if (unified.includes("%")) {
    return refuse(
      "A percent sign survived one round of decoding, which means the path was multiply encoded. That is " +
        "refused rather than decoded again: `%252e%252e` decodes once to `%2e%2e`, which contains no literal " +
        "`..` for a segment check to catch, yet the URL parser would still resolve it as a parent-directory " +
        "segment. No CurseForge path this server sends needs an escape.",
    );
  }

  for (const segment of unified.split("/")) {
    if (segment === "..") {
      return refuse("It contains a `..` segment, which could address an endpoint other than the one requested.");
    }
    if (segment === ".") return refuse("It contains a `.` segment. Paths are refused rather than resolved.");
    if (segment === "") {
      return refuse("It contains an empty segment (a doubled or trailing slash), which is ambiguous.");
    }
  }

  return unified;
}

/**
 * Refuse anything not addressed to the pinned origin, and return the path part.
 *
 * Runs BEFORE normalization, because an absolute URL's `//` would trip the
 * empty-segment rule and produce a PATH_REFUSED where the honest answer is
 * HOST_NOT_ALLOWED. Two different refusals for two different reasons.
 *
 * A caller that passes a bare path gets it back untouched — the URL is then
 * built against PINNED_ORIGIN, so there is no shape of this transport that
 * reaches another host.
 */
export function assertPinnedHost(rawPath: string): string {
  const looksAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawPath) || rawPath.startsWith("//");
  if (!looksAbsolute) return rawPath;

  const candidate = rawPath.startsWith("//") ? `https:${rawPath}` : rawPath;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new CurseForgeError(
      "HOST_NOT_ALLOWED",
      `Refused ${JSON.stringify(clip(rawPath))}. It looks like an absolute URL but does not parse as one, so ` +
        `its host cannot be checked against the pin (${PINNED_ORIGIN}).`,
      { detail: { path: clip(rawPath), pinned_origin: PINNED_ORIGIN } },
    );
  }

  if (url.origin !== PINNED_ORIGIN) {
    throw new CurseForgeError(
      "HOST_NOT_ALLOWED",
      `Refused a request to ${url.origin}. This client speaks to exactly one host, ${PINNED_ORIGIN}, and the ` +
        `pin is an ALLOW of that origin rather than a deny of any named other. CurseForge does operate a ` +
        `mutating upload API on a different host with a different auth header (ADR-002 §14.2); a method-based ` +
        `gate could not tell that request apart from POST /v1/mods, and this pin refuses it on grounds that ` +
        `have nothing to do with its path. This server also makes no Nitrado call and holds no Nitrado ` +
        `credential (§9) — this is the control that makes the first half of that mechanical.`,
      { detail: { attempted_origin: url.origin, pinned_origin: PINNED_ORIGIN } },
    );
  }

  return `${url.pathname}${url.search}`.replace(/^\/+/, "");
}

/**
 * Find the entry authorising this exact {method, path} pair, or null.
 *
 * Matched JOINTLY, and the loop makes that explicit rather than implicit:
 * E3's `GET /v1/mods/{modId}` does not authorise `DELETE /v1/mods/123`, and
 * E6's `POST /v1/mods` does not authorise `POST /v1/mods/123`.
 *
 * `normalizedPath` must already have been through `normalizePath`. The client is
 * the only caller and it normalizes exactly once, so the matcher and the URL
 * builder look at the same string.
 *
 * Query parameters do not participate in the match (§1.6) — this decides WHICH
 * endpoint; `assertPaginationBounds` decides whether the arguments are legal.
 */
export function matchEndpoint(
  method: string,
  normalizedPath: string,
  entries: readonly EndpointEntry[] = ENDPOINT_ALLOWLIST,
): EndpointEntry | null {
  for (const entry of entries) {
    if (entry.method !== method) continue;
    if (!entry.pattern.test(normalizedPath)) continue;
    return entry;
  }
  return null;
}

/** The refusal. Names the file to edit and the entry shape, because a closed list will refuse something legitimate one day. */
export function endpointRefusal(
  method: string,
  normalizedPath: string,
  entries: readonly EndpointEntry[] = ENDPOINT_ALLOWLIST,
): CurseForgeError {
  return new CurseForgeError(
    "ENDPOINT_NOT_ALLOWED",
    `Refused ${method} ${normalizedPath}. Every outbound request must match an explicit entry in the ` +
      `endpoint allow-list (src/allowlist.ts), which has ${entries.length} entr${entries.length === 1 ? "y" : "ies"}: ` +
      `${entries.map((e) => `${e.id} ${e.shape}`).join("; ")}. ` +
      `This is NOT a method check: a documented, harmless GET — ` +
      `GET /v1/mods/{modId}/files/{fileId}/download-url is the canonical example — is refused here purely ` +
      `because it is not listed, and allowing POST in general would admit everything this client can ` +
      `construct. Entries are matched on method and path JOINTLY, id segments bind to digits only, and the ` +
      `host is pinned to ${PINNED_ORIGIN}. Authorising a new endpoint means adding one line to that file in a ` +
      `review that answers "is this endpoint a read?" — which is a question a reviewer can actually answer.`,
    {
      detail: {
        method,
        path: normalizedPath,
        allowlist_size: entries.length,
        allowlist: entries.map((e) => `${e.id} ${e.method} ${e.shape}`),
        edit_to_authorise: "src/allowlist.ts → ENDPOINT_ALLOWLIST",
      },
    },
  );
}

/**
 * PAGINATION BOUNDS (ADR-002 §4). Documented AND enforced client-side.
 *
 * REFUSED, not clamped, and the reason is worth keeping in front of whoever
 * next wants to be helpful here: a model that asks for 200 and silently receives
 * 50 has no way to know it received a page instead of a set, and will reason
 * about the result as if it were complete. A refusal that says "max is 50, you
 * asked for 200" produces a correct second call. A clamp produces a wrong
 * conclusion.
 */
export function assertPaginationBounds(index: number | undefined, pageSize: number | undefined): void {
  const refuse = (message: string, detail: Record<string, unknown>): never => {
    throw new CurseForgeError("ARGUMENT_REFUSED", message, { detail });
  };

  if (pageSize !== undefined) {
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      return refuse(
        `pageSize must be an integer of at least 1, got ${JSON.stringify(pageSize)}.`,
        { page_size: pageSize },
      );
    }
    if (pageSize > MAX_PAGE_SIZE) {
      return refuse(
        `pageSize ${pageSize} exceeds CurseForge's documented maximum of ${MAX_PAGE_SIZE}. This is refused ` +
          `rather than clamped on purpose: silently returning ${MAX_PAGE_SIZE} results for a request for ` +
          `${pageSize} would let a caller reason about a page as if it were the whole set. Ask again with ` +
          `pageSize=${MAX_PAGE_SIZE} and page through using index.`,
        { page_size: pageSize, max_page_size: MAX_PAGE_SIZE },
      );
    }
  }

  if (index !== undefined) {
    if (!Number.isInteger(index) || index < 0) {
      return refuse(`index must be an integer of at least 0, got ${JSON.stringify(index)}.`, { index });
    }
  }

  const effectiveIndex = index ?? 0;
  const effectivePageSize = pageSize ?? 0;
  if (effectiveIndex + effectivePageSize > MAX_ADDRESSABLE_RESULTS) {
    const largestLegal = MAX_ADDRESSABLE_RESULTS - effectiveIndex;
    return refuse(
      `index ${effectiveIndex} plus pageSize ${effectivePageSize} exceeds CurseForge's documented ceiling of ` +
        `${MAX_ADDRESSABLE_RESULTS} (the constraint is index + pageSize <= ${MAX_ADDRESSABLE_RESULTS}). ` +
        (largestLegal > 0
          ? `The largest legal pageSize at index ${effectiveIndex} is ${largestLegal}.`
          : `Index ${effectiveIndex} is at or past the ceiling, so no pageSize is legal there. The tail of a ` +
            `result set larger than ${MAX_ADDRESSABLE_RESULTS} is not addressable through this API at all — ` +
            `narrow the filter instead of paging further.`),
      {
        index: effectiveIndex,
        page_size: effectivePageSize,
        ceiling: MAX_ADDRESSABLE_RESULTS,
        largest_legal_page_size_at_this_index: largestLegal > 0 ? largestLegal : 0,
      },
    );
  }
}

/**
 * Shape-check a bulk-read body before dispatch (ADR-002 §1.6, §4.4).
 *
 * An object with EXACTLY the expected id-array key, elements all non-negative
 * integers, array non-empty, length within our own cap. Anything else is refused
 * rather than sent and left for the upstream to reject: a body this client did
 * not construct correctly is a caller bug, and the caller here is a model.
 */
export function assertBulkBody(entry: EndpointEntry, body: unknown): void {
  const refuse = (message: string, detail: Record<string, unknown> = {}): never => {
    throw new CurseForgeError("ARGUMENT_REFUSED", `Refused ${entry.method} ${entry.shape}. ${message}`, {
      detail: { endpoint: entry.id, ...detail },
    });
  };

  if (entry.bodyKey === null) {
    return refuse(
      `A body was supplied for ${entry.id}, which is a GET entry. Only E6 (POST /v1/mods) and E7 ` +
        `(POST /v1/mods/files) may carry one. A body on a GET is a programming error and is refused rather ` +
        `than dropped, because dropping it would hide the caller's bug instead of surfacing it.`,
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse(`The body must be an object of the form { "${entry.bodyKey}": [1, 2, 3] }.`);
  }

  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== entry.bodyKey) {
    return refuse(
      `The body must carry exactly one key, "${entry.bodyKey}", and got ${JSON.stringify(keys)}. An extra key ` +
        `is refused rather than ignored: this client should never be constructing a body it cannot describe.`,
      { expected_key: entry.bodyKey, got_keys: keys },
    );
  }

  const ids = (body as Record<string, unknown>)[entry.bodyKey];
  if (!Array.isArray(ids)) return refuse(`"${entry.bodyKey}" must be an array of ids.`);
  if (ids.length === 0) {
    return refuse(
      `"${entry.bodyKey}" is empty. An empty bulk read is a caller bug, not a request for nothing — and an ` +
        `empty result from it would be indistinguishable from "no such mods", which §6 forbids conflating.`,
    );
  }
  if (ids.length > MAX_BULK_IDS) {
    return refuse(
      `"${entry.bodyKey}" carries ${ids.length} ids, over this repo's own cap of ${MAX_BULK_IDS}. That cap is ` +
        `OURS, not CurseForge's: no vendor cap is documented and none has been observed (ADR-002 §14.3 U10). ` +
        `Chunk the ids and issue one request per chunk.`,
      { id_count: ids.length, max_bulk_ids: MAX_BULK_IDS, cap_is_ours_not_the_vendors: true },
    );
  }
  for (const [position, id] of ids.entries()) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
      return refuse(
        `"${entry.bodyKey}"[${position}] is ${JSON.stringify(id)}. Every element must be a non-negative ` +
          `integer id. Strings are not coerced: a string here means the caller has an id it did not parse, ` +
          `and coercing it would send a request nobody meant.`,
        { offending_index: position },
      );
    }
  }
}

/** Keep a caller-influenced string out of messages at full length. */
function clip(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}...` : value;
}

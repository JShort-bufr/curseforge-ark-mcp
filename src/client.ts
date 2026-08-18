import {
  assertBulkBody,
  assertPaginationBounds,
  assertPinnedHost,
  endpointRefusal,
  ENDPOINT_ALLOWLIST,
  matchEndpoint,
  MAX_ADDRESSABLE_RESULTS,
  normalizePath,
  PINNED_ORIGIN,
  POST_CAPABLE_TOOLS,
  type EndpointEntry,
  type HttpMethod,
} from "./allowlist.js";
import type { Config } from "./config.js";
import { CurseForgeError, errorForStatus } from "./errors.js";
import { safeSnippet, scrubKey } from "./scrub.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: HttpMethod;
  /** Path relative to the pinned origin. Leading slash optional. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Bulk-read body, sent as JSON. Legal ONLY on E6 and E7, shape-checked before
   * dispatch, and refused rather than dropped on a GET entry.
   */
  body?: Record<string, unknown>;
  /**
   * The tool making the request. Required for a POST, because ADR-002 §8 says
   * exactly one tool may reach a POST entry and that is enforced here rather
   * than promised in a docstring.
   */
  tool?: string;
}

/**
 * The normalized page descriptor handed to tools (ADR-002 §3).
 *
 * SURFACED TO THE MODEL, not consumed by the client. Every paginated tool's
 * output states these numbers, because the model cannot reason about
 * completeness it was never told about.
 */
export interface PageDescriptor {
  index: number | null;
  page_size: number | null;
  result_count: number | null;
  total_count: number | null;
  /** Whether more results exist beyond this page. null when the numbers do not permit an answer. */
  has_more: boolean | null;
  /**
   * True when totalCount exceeds the API's own addressable window, i.e. the tail
   * of this result set CANNOT BE REACHED by paging (§4.3). Said in those words
   * because hiding it produces a search the model believes it exhausted.
   */
  tail_unreachable: boolean | null;
}

/** What one request returned: the unwrapped `data`, plus the page descriptor when there was one. */
export interface Envelope<T = unknown> {
  data: T;
  page: PageDescriptor | null;
}

/** What CurseForge last said about rate limiting, if it says anything at all. */
export interface RateLimitSnapshot {
  /** Header name → raw value, exactly as received. Not parsed into a shape nobody has observed. */
  headers: Record<string, string>;
  seen_at: string;
  seen_on: string;
}

export interface ClientOptions {
  /**
   * A synthetic allow-list, for tests only.
   *
   * Injectable for one reason, and it is the opposite of the sibling repo's:
   * there the list ships EMPTY so a refusal suite needed a synthetic list to
   * have anything to match. Here the real list has seven entries, so the
   * preimage tests run against the SHIPPED list and this seam exists only to
   * prove the matcher is not hardcoded to those seven — e.g. that first-match
   * ordering is deterministic. Refusal tests must use the real list.
   */
  endpoints?: readonly EndpointEntry[];
  /** Tools permitted to issue a POST (§8). Injectable for the same narrow reason. */
  postCapableTools?: readonly string[];
}

/**
 * THE SINGLE CHOKEPOINT.
 *
 * Every outbound CurseForge request goes through `request()`, and it is the ONLY
 * place the `x-api-key` header is attached. One place to attach the credential,
 * one place a request can be refused (ADR-002 §1.4, §2).
 *
 * Enforcement lives in the transport rather than in each tool on purpose, and
 * the sibling README's argument holds verbatim: a per-tool check is a rule a
 * future tool can forget, whereas a transport check is one it cannot route
 * around without deleting it.
 */
export class CurseForgeClient {
  private readonly config: Config;
  private readonly fetchImpl: FetchLike;
  private readonly endpoints: readonly EndpointEntry[];
  private readonly postCapableTools: readonly string[];
  private nextSlotAt = 0;
  private rateLimit: RateLimitSnapshot | null = null;

  constructor(config: Config, fetchImpl: FetchLike = globalThis.fetch, options: ClientOptions = {}) {
    if (config.apiBase !== PINNED_ORIGIN) {
      // Not reachable from the environment — Config.apiBase is not settable —
      // but asserted anyway, because the host pin is one of two independent
      // reasons the §14.2 upload API is refused and a field that could drift
      // would quietly make it one.
      throw new CurseForgeError(
        "CONFIG",
        `The API base is pinned to ${PINNED_ORIGIN} and this client was handed ${JSON.stringify(config.apiBase)}. ` +
          `The pin is a control (ADR-002 §1.6), not a default: an overridable base URL is an unpinned host ` +
          `with extra steps.`,
        { detail: { pinned_origin: PINNED_ORIGIN, given: config.apiBase } },
      );
    }
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.endpoints = options.endpoints ?? ENDPOINT_ALLOWLIST;
    this.postCapableTools = options.postCapableTools ?? POST_CAPABLE_TOOLS;
  }

  /** What CurseForge last reported about rate limiting. `null` until a response carried such a header. */
  get lastRateLimit(): RateLimitSnapshot | null {
    return this.rateLimit;
  }

  /**
   * The chokepoint's decision. Returns the authorising entry, or throws.
   *
   * `path` MUST already be normalized. `request()` is the only caller and it
   * normalizes exactly once, so the matcher and the URL builder see the same
   * string. There is no second string.
   */
  private assertAllowed(method: HttpMethod, path: string, tool: string | undefined): EndpointEntry {
    const entry = matchEndpoint(method, path, this.endpoints);
    if (entry === null) throw endpointRefusal(method, path, this.endpoints);

    // §8, as a control rather than a convention. Exactly two entries carry POST
    // and exactly one tool may reach them; a second tool wanting a bulk read is
    // a review, not a convenience.
    if (entry.method === "POST" && !this.postCapableTools.includes(tool ?? "")) {
      throw new CurseForgeError(
        "ENDPOINT_NOT_ALLOWED",
        `Refused ${method} ${path}. ${entry.id} is a bulk-read POST and ADR-002 §8 permits exactly one tool to ` +
          `reach one: ${this.postCapableTools.join(", ")}. This request declared ` +
          `${tool === undefined ? "no tool at all" : JSON.stringify(tool)}. A future tool wanting a bulk read ` +
          `is a review, not a convenience — add it to POST_CAPABLE_TOOLS in src/allowlist.ts.`,
        { detail: { endpoint: entry.id, method, path, tool: tool ?? null, post_capable_tools: this.postCapableTools } },
      );
    }

    return entry;
  }

  /**
   * Record whatever rate-limit headers a response carried.
   *
   * Deliberately unparsed, and stored as raw strings. CurseForge's rate limit is
   * UNDOCUMENTED (§14.3 U11): no published figure, and no confirmed header
   * names. Parsing into an invented `{limit, remaining}` shape would be a claim
   * about a contract nobody here has observed. The honest artifact is "here is
   * what the response said", or null.
   */
  private captureRateLimit(response: Response, url: string): void {
    const captured: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (lower.startsWith("x-ratelimit") || lower.startsWith("ratelimit") || lower === "retry-after") {
        captured[lower] = value;
      }
    });
    if (Object.keys(captured).length === 0) return;
    this.rateLimit = {
      headers: captured,
      seen_at: new Date().toISOString(),
      seen_on: safePath(url),
    };
  }

  /** Self-imposed pacing against an API with no published quota. */
  private async throttle(): Promise<void> {
    const intervalMs = 1000 / this.config.requestsPerSecond;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + intervalMs;
    const waitMs = slot - now;
    if (waitMs > 0) await new Promise((done) => setTimeout(done, waitMs));
  }

  /** Built from the ALREADY-NORMALIZED path against the pinned origin, so the string checked is the string sent. */
  private buildUrl(normalizedPath: string, query: RequestOptions["query"]): string {
    const url = new URL(`${PINNED_ORIGIN}/${normalizedPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    // Belt and braces. `normalizePath` has already refused everything that could
    // make the parser wander, but the pin is one of two independent reasons a
    // request to another host is refused, and an assertion on the FINAL string is
    // the one that cannot be reasoned around.
    if (url.origin !== PINNED_ORIGIN) {
      throw new CurseForgeError(
        "HOST_NOT_ALLOWED",
        `The built URL resolved to ${url.origin}, which is not the pinned origin ${PINNED_ORIGIN}. Refused.`,
        { detail: { attempted_origin: url.origin, pinned_origin: PINNED_ORIGIN } },
      );
    }
    return url.toString();
  }

  /**
   * Unwrap `{ data, pagination }` — ONCE, here, for everything (ADR-002 §3).
   *
   * No tool reaches into `.data` itself. A second unwrap site is a second
   * envelope contract, and the two would drift.
   */
  private unwrap(entry: EndpointEntry, body: unknown, path: string): Envelope {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new CurseForgeError(
        "UPSTREAM_SHAPE",
        `${entry.method} ${path} returned a JSON value that is not an object, so it cannot carry the ` +
          `documented { data, pagination } envelope.`,
        { detail: { endpoint: entry.id, path } },
      );
    }

    const record = body as Record<string, unknown>;

    if (!Object.hasOwn(record, "data")) {
      throw new CurseForgeError(
        "UPSTREAM_SHAPE",
        `${entry.method} ${path} returned a body with no \`data\` key. The documented envelope is ` +
          `{ data, pagination }, so the upstream shape is not what this client was written for. This is an ` +
          `ERROR rather than an empty result on purpose: coercing a missing \`data\` to [] would convert a ` +
          `broken integration into "no results found", which is a confident wrong answer. Keys present: ` +
          `${JSON.stringify(Object.keys(record))}.`,
        { detail: { endpoint: entry.id, path, keys_present: Object.keys(record) } },
      );
    }

    const pagination = record["pagination"];
    const hasPagination = typeof pagination === "object" && pagination !== null && !Array.isArray(pagination);

    if (entry.paginated && !hasPagination) {
      throw new CurseForgeError(
        "UPSTREAM_SHAPE",
        `${entry.method} ${path} is a paginated endpoint (${entry.id}) and returned no \`pagination\` object. ` +
          `This client does NOT assume one page: assuming one page is how a tool reports 50 of 900 mods as if ` +
          `it were all of them. If CurseForge genuinely behaves this way, that is a documented quirk with a ` +
          `live observation behind it (ADR-002 §14.3 U8 is exactly this open question) — not a default to ` +
          `absorb silently.`,
        { detail: { endpoint: entry.id, path, unverified_row: "U8" } },
      );
    }

    // `pagination` absent on a single-record endpoint (E3, E5, and the bulk
    // reads) is NORMAL. Do not synthesise one.
    return { data: record["data"], page: hasPagination ? describePage(pagination as Record<string, unknown>) : null };
  }

  async request<T = unknown>(options: RequestOptions): Promise<Envelope<T>> {
    const method: HttpMethod = options.method ?? "GET";

    // ORDER MATTERS HERE, and each step answers a different question:
    //   1. host pin      — is this even our host?         (§1.6)
    //   2. normalization — is this path safe to reason about? (§1.6)
    //   3. allow-list    — is this endpoint authorised?    (§1.4)
    //   4. arguments     — are the arguments legal?        (§4)
    // Steps 3 and 4 are two controls with two failure messages on purpose: the
    // allow-list decides WHICH endpoint, §4 decides whether the arguments are
    // legal, and merging them would produce one confusing refusal for two
    // unrelated mistakes.
    const hostChecked = assertPinnedHost(options.path);
    const path = normalizePath(hostChecked);
    const entry = this.assertAllowed(method, path, options.tool);

    if (options.body !== undefined) {
      assertBulkBody(entry, options.body);
    } else if (entry.bodyKey !== null) {
      throw new CurseForgeError(
        "ARGUMENT_REFUSED",
        `${entry.id} (${entry.shape}) is a bulk read and requires a body. Sending it without one would ask ` +
          `CurseForge for the records of no ids, and whatever came back would be indistinguishable from ` +
          `"none matched".`,
        { detail: { endpoint: entry.id } },
      );
    }

    const rawIndex = options.query?.["index"];
    const rawPageSize = options.query?.["pageSize"];
    assertPaginationBounds(
      typeof rawIndex === "number" ? rawIndex : undefined,
      typeof rawPageSize === "number" ? rawPageSize : undefined,
    );

    const url = this.buildUrl(path, options.query);

    await this.throttle();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      // THE ONLY PLACE THE CREDENTIAL IS ATTACHED, and it is `x-api-key` — NOT
      // the `Authorization: Bearer` scheme the sibling repo uses for Nitrado.
      // Both schemes are deliberately not supported: "support both" would mean
      // this code could send the key in a form CurseForge never documented.
      const headers: Record<string, string> = {
        "x-api-key": this.config.apiKey,
        Accept: "application/json",
        "User-Agent": "curseforge-ark-mcp/0.2.0",
      };

      let encodedBody: string | undefined;
      if (options.body !== undefined) {
        encodedBody = JSON.stringify(options.body);
        headers["Content-Type"] = "application/json";
      }

      try {
        response = await this.fetchImpl(url, {
          method,
          signal: controller.signal,
          headers,
          ...(encodedBody === undefined ? {} : { body: encodedBody }),
        });
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") {
          // Every request this client can make is a READ, so a timeout genuinely
          // does mean "it did not happen". There is no UNKNOWN_OUTCOME code here
          // and there must not be one: the sibling repo needs that distinction
          // because a lost response to a PUT may still have changed the world.
          throw new CurseForgeError(
            "TIMEOUT",
            `CurseForge did not respond to ${method} ${path} within ${this.config.requestTimeoutMs}ms. Every ` +
              `endpoint this client can reach is a read, so nothing was changed and a retry is safe.`,
            { detail: { method, path }, cause },
          );
        }
        throw new CurseForgeError(
          "UPSTREAM",
          // Scrubbed because a network-layer error string can echo the request,
          // and the request carries the key in a header.
          `Network error reaching CurseForge for ${method} ${path}: ${scrubKey(String(cause), this.config.apiKey)}`,
          { detail: { method, path }, cause },
        );
      }
    } finally {
      clearTimeout(timer);
    }

    this.captureRateLimit(response, url);

    const text = await response.text();

    if (!response.ok) {
      throw errorForStatus(response.status, method, path, safeSnippet(text, this.config.apiKey));
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (cause) {
      throw new CurseForgeError("UPSTREAM", `CurseForge returned non-JSON for ${method} ${path}.`, {
        httpStatus: response.status,
        detail: { method, path, body_snippet: safeSnippet(text, this.config.apiKey) },
        cause,
      });
    }

    return this.unwrap(entry, body, path) as Envelope<T>;
  }
}

/**
 * Normalize a `pagination` object into the descriptor tools surface.
 *
 * Missing numbers stay `null`, never 0 (ADR-002 §6). A `totalCount` of null is
 * "the API did not say", and reporting it as 0 would tell the model a search
 * found nothing when in fact nothing was measured.
 */
function describePage(pagination: Record<string, unknown>): PageDescriptor {
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  const index = num(pagination["index"]);
  const pageSize = num(pagination["pageSize"]);
  const resultCount = num(pagination["resultCount"]);
  const totalCount = num(pagination["totalCount"]);

  const hasMore =
    index === null || resultCount === null || totalCount === null ? null : index + resultCount < totalCount;

  return {
    index,
    page_size: pageSize,
    result_count: resultCount,
    total_count: totalCount,
    has_more: hasMore,
    tail_unreachable: totalCount === null ? null : totalCount > MAX_ADDRESSABLE_RESULTS,
  };
}

/** Path only, for tracing. Never the full URL: query strings are echoed in fewer places, not more. */
function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "unparseable";
  }
}

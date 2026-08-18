/**
 * Stable error taxonomy.
 *
 * Every tool surfaces one of these codes so the model (and a human reading a
 * transcript) can tell "CurseForge said no" from "our own chokepoint said no"
 * from "the upstream shape is not what this client was written for".
 *
 * ADR-002 §6 is the rule these codes exist to keep: a tool that cannot
 * determine an answer must raise one of these rather than returning an empty
 * list or a zero. `data: []` from a search is a real answer — no mods matched —
 * and must never double as "we could not tell".
 */
export type ErrorCode =
  /**
   * OUR OWN CHOKEPOINT refused the request because no allow-list entry matched
   * the {method, path} pair. ADR-002 §1. Nothing was sent.
   *
   * The failure mode this code represents is "unmatched request refused", never
   * "unrecognised request sent".
   */
  | "ENDPOINT_NOT_ALLOWED"
  /**
   * Our own chokepoint refused the request because it was not addressed to the
   * pinned host. ADR-002 §1.6. Independent of ENDPOINT_NOT_ALLOWED on purpose:
   * the documented CurseForge upload API is a mutating POST on a different host,
   * and it is refused twice — once on the path, once here.
   */
  | "HOST_NOT_ALLOWED"
  /** Our own chokepoint refused a path as unnormalizable: traversal, double encoding, empty segment. */
  | "PATH_REFUSED"
  /**
   * Our own argument validation refused the request before dispatch: a page size
   * over the documented 50, an `index + pageSize` over the documented 10000, or
   * a bulk-read body that failed its shape check. ADR-002 §4.
   *
   * Distinct from ENDPOINT_NOT_ALLOWED because they answer different questions.
   * The allow-list decides WHICH endpoint; this decides whether the ARGUMENTS
   * are legal. Two controls, two failure messages.
   */
  | "ARGUMENT_REFUSED"
  /**
   * The parsed response did not carry the envelope this client was written for:
   * no `data` key, or no `pagination` on a paginated endpoint. ADR-002 §3.
   *
   * NOT coerced to an empty result. Coercing a missing `data` to `[]` converts a
   * broken integration into "no results found", which is a confident wrong
   * answer and the exact defect class this repo's tests exist to catch.
   */
  | "UPSTREAM_SHAPE"
  /** HTTP 401/403. The key is missing, wrong, revoked, or not entitled to this resource. */
  | "AUTH_INVALID"
  /** HTTP 429. CurseForge publishes no rate limit (§14.3 U11), so no wait time is invented. */
  | "RATE_LIMITED"
  /** HTTP 404. */
  | "NOT_FOUND"
  /** Any other non-2xx, or an unparseable body. */
  | "UPSTREAM"
  /** The request exceeded the per-request timeout. Every request here is a read, so this means "it did not happen". */
  | "TIMEOUT"
  /**
   * The ARK: Survival Ascended gameId could not be resolved from GET /v1/games.
   * ADR-002 §5. Never falls back to a guessed integer: a wrong gameId on
   * /v1/mods/search does not error, it returns a clean, empty, entirely wrong
   * result set, which is the worst failure mode available.
   */
  | "GAME_UNRESOLVED"
  /** Startup / environment misconfiguration, including a missing API key. */
  | "CONFIG";

export class CurseForgeError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number | null;
  readonly detail: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { httpStatus?: number | null; detail?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CurseForgeError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.detail = options.detail ?? {};
  }

  /** Shape handed back to the MCP client. Never includes the key, and never includes any request header. */
  toPayload(): Record<string, unknown> {
    return {
      error: true,
      code: this.code,
      message: this.message,
      http_status: this.httpStatus,
      ...this.detail,
    };
  }
}

/**
 * Map an HTTP status to a code.
 *
 * `snippet` has already been bounded and key-scrubbed by the caller. Request
 * headers are never included here — not the key, not a redacted key, not a list
 * of header names (ADR-002 §12.1). Errors name method, path, and status.
 */
export function errorForStatus(
  status: number,
  method: string,
  path: string,
  snippet: string,
): CurseForgeError {
  const where = { method, path };
  switch (status) {
    case 401:
      return new CurseForgeError(
        "AUTH_INVALID",
        // No header name appears here. §12.1 forbids request headers in errors —
        // "not the key, not a redacted key, not a header-name list" — and the
        // startup message in src/config.ts is the right place to explain how the
        // credential is transmitted, because that one runs before any request.
        "CurseForge rejected the API key (401). Check CURSEFORGE_API_KEY. Note that this key is not " +
          "self-service: it is granted by application to Overwolf and is non-transferable, so a bad key " +
          "means reapplying rather than regenerating.",
        { httpStatus: 401, detail: where },
      );
    case 403:
      return new CurseForgeError(
        "AUTH_INVALID",
        "CurseForge accepted the request but refused this resource (403). The key may not be entitled to " +
          "this game or endpoint. CurseForge publishes no read-only scope and no scope selection, so there " +
          "is no scope to widen — this is an entitlement question for Overwolf, not a configuration one.",
        { httpStatus: 403, detail: where },
      );
    case 404:
      return new CurseForgeError("NOT_FOUND", `CurseForge has no resource at ${method} ${path} (404).`, {
        httpStatus: 404,
        detail: where,
      });
    case 429:
      return new CurseForgeError(
        "RATE_LIMITED",
        "CurseForge rate-limited this request (429). CurseForge publishes NO rate-limit figure, so there is " +
          "no reliable wait time to report and none is invented here. Pause, then retry. Call " +
          "get_api_diagnostics to see whatever rate-limit headers the last response actually carried.",
        { httpStatus: 429, detail: where },
      );
    default:
      return new CurseForgeError("UPSTREAM", `CurseForge returned HTTP ${status} for ${method} ${path}.`, {
        httpStatus: status,
        detail: { ...where, body_snippet: snippet },
      });
  }
}

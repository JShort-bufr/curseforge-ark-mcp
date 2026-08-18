import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CurseForgeClient, type FetchLike } from "../src/client.js";
import type { Config } from "../src/config.js";
import { createGameResolver, type GameResolver } from "../src/game.js";
import { PINNED_ORIGIN } from "../src/allowlist.js";
import type { ToolContext } from "../src/tools/context.js";

/**
 * SYNTHETIC FIXTURES.
 *
 * ADR-002 open question 4, and the sibling repo's amended rule: fixtures are
 * **synthetic in content, structural in shape**. The STRUCTURE below is derived
 * from CurseForge's published response schemas — field names, nesting, and the
 * `{ data, pagination }` envelope are all as documented. EVERY VALUE IS INVENTED.
 *
 * AMENDED 2026-08-18. The structure is no longer a hypothesis: it was checked
 * against 1899 live file records across 748 mods, and the nested shapes below
 * (`sortableGameVersions`, `latestFilesIndexes`, and the presence of a populated
 * `downloadUrl` on every file) are now copied from what the API actually sends.
 * Every VALUE is still invented, which is the half of the rule that never expires.
 *
 * One structural element remains a hypothesis, and it is the one that matters:
 * `dependencies` entries. Zero dependency edges existed in that entire sample, so
 * the `{ modId, relationType }` element shape below is still documentation-derived
 * and the fixture is the ONLY place it has ever appeared. Tests over it prove this
 * client handles the shape it was written for, and nothing about what CurseForge
 * would send if an ASA mod ever declared one.
 *
 * PREIMAGE DISCIPLINE, non-negotiable (§1.8): a test that proves a request was
 * refused must first prove the request would otherwise have been sent, and a test
 * that proves a field was read must first prove the fixture contains it. The
 * `*_PREIMAGE` exports below exist so a refusal or field-path test cannot pass
 * vacuously against an empty fixture.
 */

/** A key-shaped string. Synthetic, obviously so, and long enough to clear scrubKey's 8-char floor. */
export const FAKE_API_KEY = "SYNTHETIC-cf-key-not-a-real-credential-zzq7";

/** Invented ids. Distinctive so a test can search output for them by substring. */
export const FAKE_GAME_ID = 90_001;
export const FAKE_GAME_SLUG = "ark-survival-ascended";
export const FAKE_GAME_NAME = "ARK: Survival Ascended (synthetic fixture)";
export const FAKE_MOD_ID = 777_001;
export const FAKE_DEP_MOD_ID = 777_002;
export const FAKE_DEEP_MOD_ID = 777_003;
export const FAKE_FILE_ID = 555_001;
export const FAKE_OLDER_FILE_ID = 555_000;

/**
 * Raw relation and release integers. INVENTED, and deliberately not 1/2/3.
 *
 * ADR-002 §14.3 U6/U7: neither numeric enum is published. Using plausible-looking
 * small integers in a fixture would invite a reader to infer a mapping from the
 * fixture, which is precisely the guess this repo refuses to make. 41 and 42 mean
 * nothing, which is the honest amount.
 */
export const FAKE_RELATION_TYPE = 41;
export const FAKE_OTHER_RELATION_TYPE = 42;
export const FAKE_RELEASE_TYPE = 71;
export const FAKE_OTHER_RELEASE_TYPE = 72;

export const FAKE_GAME_VERSION = "9.99.9-synthetic";

/**
 * The download URL that must never reach a tool result. Distinctive so a leak test
 * can search for it by substring, in the sibling repo's idiom.
 */
export const FAKE_DOWNLOAD_URL_MARKER = "should-never-be-surfaced";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: FAKE_API_KEY,
    apiBase: PINNED_ORIGIN,
    gameSlug: null,
    // High so the self-imposed throttle does not slow the suite down.
    requestsPerSecond: 10,
    requestTimeoutMs: 5_000,
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface StubRoute {
  match: RegExp;
  method?: string;
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * A fetch stub that RECORDS EVERY CALL and answers from a routing table.
 *
 * The recording is what makes the refusal tests non-vacuous. §1.8 requires
 * asserting on the call COUNT, not merely on the thrown error: an error can be
 * thrown after a request was sent, and "refused before the request is built" is
 * the actual provision.
 */
export function stubFetch(routes: StubRoute[]): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });

    const method = (init?.method ?? "GET").toUpperCase();
    for (const route of routes) {
      if (route.method !== undefined && route.method.toUpperCase() !== method) continue;
      if (!route.match.test(url)) continue;
      return jsonResponse(route.body, route.status ?? 200, route.headers ?? {});
    }
    return jsonResponse({ error: `no stub route for ${method} ${url}` }, 404);
  };
  return { fetchImpl, calls };
}

export function testClient(
  routes: StubRoute[],
  overrides: Partial<Config> = {},
): { client: CurseForgeClient; calls: RecordedCall[]; config: Config } {
  const config = testConfig(overrides);
  const { fetchImpl, calls } = stubFetch(routes);
  return { client: new CurseForgeClient(config, fetchImpl), calls, config };
}

export function makeContext(
  routes: StubRoute[],
  overrides: Partial<Config> = {},
): { ctx: ToolContext; calls: RecordedCall[]; games: GameResolver } {
  const { client, config, calls } = testClient(routes, overrides);
  const games = createGameResolver(client, { configuredSlug: config.gameSlug });
  return { ctx: { client, config, games }, calls, games };
}

// ---------------------------------------------------------------------------
// Response bodies. Structure from the published schemas, values invented.
// ---------------------------------------------------------------------------

/** GET /v1/games — paginated, so it MUST carry `pagination` or §3 errors. */
export function gamesBody(games: unknown[] = [{ id: FAKE_GAME_ID, slug: FAKE_GAME_SLUG, name: FAKE_GAME_NAME }]) {
  return { data: games, pagination: pagination(games.length, games.length) };
}

export function pagination(resultCount: number, totalCount: number, index = 0, pageSize = 50) {
  return { index, pageSize, resultCount, totalCount };
}

/** One `File` record (§14.3 U4/U5). */
export function fileRecord(
  overrides: Partial<{
    id: number;
    modId: number;
    displayName: string;
    fileName: string;
    fileDate: string;
    releaseType: number;
    gameVersions: string[];
    dependencies: Array<{ modId: number; relationType: number }>;
  }> = {},
) {
  return {
    id: FAKE_FILE_ID,
    modId: FAKE_MOD_ID,
    displayName: "Synthetic Mod v2.1",
    fileName: "synthetic-mod-2.1.zip",
    fileDate: "2026-08-10T12:00:00Z",
    releaseType: FAKE_RELEASE_TYPE,
    isAvailable: true,
    gameVersions: [FAKE_GAME_VERSION],
    // Inner shape copied from a live record (2026-08-18); values invented.
    sortableGameVersions: [
      {
        gameVersionName: FAKE_GAME_VERSION,
        gameVersionPadded: "0000000009.0000000099",
        gameVersion: "9.99.9",
        gameVersionReleaseDate: "2026-01-01T00:00:00Z",
        gameVersionTypeId: 99_367,
      },
    ],
    dependencies: [{ modId: FAKE_DEP_MOD_ID, relationType: FAKE_RELATION_TYPE }],
    /**
     * PRESENT ON PURPOSE, and this fixture field is a control rather than realism.
     *
     * Live File records carry a populated `downloadUrl`. DEC-002 §11.3 refuses any
     * download or install capability, and ADR-002 §1.7 delivers that by keeping the
     * download-url ENDPOINT off the allow-list — which turns out not to be
     * sufficient on its own, because the URL rides along inside records fetched
     * from endpoints that ARE allowed. `shapeFile` drops it. This value exists so
     * the test proving it gets dropped has a non-empty preimage.
     */
    downloadUrl: `https://example.invalid/synthetic-download/${FAKE_FILE_ID}/should-never-be-surfaced.zip`,
    ...overrides,
  };
}

/** One `Mod` record (§14.3 U3). */
export function modRecord(
  overrides: Partial<{
    id: number;
    name: string;
    slug: string;
    latestFiles: unknown[];
    dateModified: string;
  }> = {},
) {
  return {
    id: FAKE_MOD_ID,
    gameId: FAKE_GAME_ID,
    name: "Synthetic Structures Plus",
    slug: "synthetic-structures-plus",
    dateModified: "2026-08-10T12:00:00Z",
    allowModDistribution: true,
    links: { websiteUrl: "https://example.invalid/synthetic-mod" },
    categories: [{ id: 4_242, name: "Synthetic Category" }],
    latestFiles: [fileRecord()],
    // Inner shape copied from a live record (2026-08-18); values invented.
    latestFilesIndexes: [
      {
        gameVersion: "9.99.9",
        fileId: FAKE_FILE_ID,
        filename: "synthetic-mod-2.1.zip",
        releaseType: FAKE_RELEASE_TYPE,
        gameVersionTypeId: 99_367,
      },
    ],
    ...overrides,
  };
}

/**
 * PREIMAGE for the Mod field-path tests.
 *
 * Every dotted path a test asserts this client can read. Asserted NON-EMPTY and
 * asserted PRESENT IN THE FIXTURE before any test claims a value was read
 * correctly — otherwise a field-path suite over an empty object passes perfectly
 * and proves nothing.
 */
export const MOD_FIELD_PREIMAGE: readonly string[] = [
  "id",
  "gameId",
  "name",
  "slug",
  "dateModified",
  "allowModDistribution",
  "links.websiteUrl",
  "categories",
  "latestFiles",
  "latestFilesIndexes",
];

/** PREIMAGE for the File field-path tests (§14.3 U4/U5). */
export const FILE_FIELD_PREIMAGE: readonly string[] = [
  // Every path below was confirmed present in live responses on 2026-08-18.
  "id",
  "modId",
  "displayName",
  "fileName",
  "fileDate",
  "isAvailable",
  "gameVersions",
  "sortableGameVersions",
  "releaseType",
  "dependencies",
];

/** Read a dotted path out of a plain object, for preimage assertions. */
export function readPath(source: unknown, dotted: string): unknown {
  let current: unknown = source;
  for (const key of dotted.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Routes covering every endpoint the tool tests touch. */
export function standardRoutes(): StubRoute[] {
  return [
    { match: /\/v1\/games(\?|$)/, method: "GET", body: gamesBody() },
    {
      match: /\/v1\/mods\/search/,
      method: "GET",
      body: { data: [modRecord()], pagination: pagination(1, 1) },
    },
    { match: /\/v1\/mods\/\d+\/files\/\d+$/, method: "GET", body: { data: fileRecord() } },
    {
      match: /\/v1\/mods\/\d+\/files(\?|$)/,
      method: "GET",
      body: { data: [fileRecord()], pagination: pagination(1, 1) },
    },
    { match: /\/v1\/mods\/\d+$/, method: "GET", body: { data: modRecord() } },
    { match: /\/v1\/mods\/files$/, method: "POST", body: { data: [fileRecord()] } },
    { match: /\/v1\/mods$/, method: "POST", body: { data: [modRecord()] } },
  ];
}

/**
 * Locate the repository root from a COMPILED test.
 *
 * Tests run from `dist/test/`, so `new URL("../src/", import.meta.url)` resolves
 * to `dist/src/` — which holds .js, not .ts. A source-scanning test written that
 * way finds zero files and passes vacuously, which is the same defect class as a
 * redaction test over an empty fixture. Walking up to the package.json is the one
 * spelling that is right from either location.
 */
export function repoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("could not locate the repository root from the test directory");
}

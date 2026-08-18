import type { CurseForgeClient } from "./client.js";
import { asNumber, asString } from "./coerce.js";
import { CurseForgeError } from "./errors.js";

/**
 * CAPABILITY DETECTION OVER ASSUMPTION (ADR-002 §5).
 *
 * The ARK: Survival Ascended `gameId` is NOT hardcoded. It is discovered at
 * runtime from GET /v1/games (E1) and cached for the process lifetime only.
 *
 * Why this matters more than it looks: a wrong `gameId` on
 * GET /v1/mods/search DOES NOT ERROR. `gameId` is a required filter, so a wrong
 * one returns a clean, empty, entirely wrong result set. That is the worst
 * available failure mode — the model gets a confident "no mods found" — and a
 * hardcoded constant is exactly how you get it.
 *
 * NEITHER THE ID NOR THE SLUG COULD BE CHECKED (§14.3 U1, U2). GET /v1/games
 * returns "all games that are available to the provided API key", and "a private
 * game is only accessible by its respective API key" — so both the ASA gameId
 * and whether ASA is visible to this key AT ALL are unresolvable until a key
 * exists. If ASA turns out not to be visible to the granted key, that is a
 * v1-blocking discovery for the board, not something to work around here.
 */

/**
 * Slug candidates, in order of preference.
 *
 * HYPOTHESES, every one. These are guesses at what CurseForge calls the game,
 * not observations. `CURSEFORGE_GAME_SLUG` exists so that the first person with
 * a key can correct this in configuration rather than in code.
 */
export const ASA_SLUG_CANDIDATES: readonly string[] = ["ark-survival-ascended", "arksa"];

/**
 * Name substrings, lowercased, tried when no slug matched.
 *
 * Separate from the slug list on purpose: matching a display NAME is fuzzier
 * than matching a slug, so it runs second and the resolution result records
 * which of the two answered. "Survival Ascended" and not "ARK" — plain "ark"
 * would also match ARK: Survival Evolved, which is a DIFFERENT GAME with a
 * different mod catalog, and quietly resolving to it would produce results that
 * look entirely plausible and are entirely wrong.
 */
export const ASA_NAME_CANDIDATES: readonly string[] = ["survival ascended"];

export interface GameResolution {
  game_id: number;
  /** The slug CurseForge reported for the matched game, or null if it reported none. */
  slug: string | null;
  name: string | null;
  /** Which rule matched: an explicit configured slug, a candidate slug, or a name substring. */
  matched_by: "configured-slug" | "candidate-slug" | "name-substring";
  /** How many games the key could see. Recorded because it is the number a failure needs. */
  games_visible: number;
}

/** Injected rather than a module singleton (ADR-002 open question 5), so a test can supply one without a fixture. */
export interface GameResolver {
  /** Resolve once and cache for the process lifetime. Throws GAME_UNRESOLVED rather than guessing. */
  resolve(): Promise<GameResolution>;
  /** What resolution produced last time, without triggering one. null when it has not run. */
  peek(): GameResolution | null;
  /** The failure from the last attempt, if it failed. Lets diagnostics report the failure without re-raising. */
  lastError(): string | null;
}

export interface ResolverOptions {
  /** An explicit slug from configuration. Tried first, and its failure is reported differently. */
  configuredSlug?: string | null;
  slugCandidates?: readonly string[];
  nameCandidates?: readonly string[];
}

export function createGameResolver(client: CurseForgeClient, options: ResolverOptions = {}): GameResolver {
  const configuredSlug = options.configuredSlug ?? null;
  const slugCandidates = options.slugCandidates ?? ASA_SLUG_CANDIDATES;
  const nameCandidates = options.nameCandidates ?? ASA_NAME_CANDIDATES;

  let cached: GameResolution | null = null;
  let lastError: string | null = null;
  let inFlight: Promise<GameResolution> | null = null;

  const attempt = async (): Promise<GameResolution> => {
    // E1. Paginated, so the client will error rather than assume one page if
    // CurseForge omits `pagination` — see §3 and U8.
    const { data } = await client.request<unknown>({ path: "v1/games", tool: "capability-detection" });

    if (!Array.isArray(data)) {
      throw new CurseForgeError(
        "GAME_UNRESOLVED",
        `GET /v1/games returned a \`data\` value that is not an array, so the game list could not be searched ` +
          `for ARK: Survival Ascended. The gameId is deliberately never guessed: a wrong one returns a clean, ` +
          `empty, entirely wrong search result set.`,
        { detail: { unverified_rows: ["U1", "U2"] } },
      );
    }

    const games = data.map((game) => ({
      id: asNumber((game as Record<string, unknown> | null)?.["id"] ?? undefined),
      slug: asString((game as Record<string, unknown> | null)?.["slug"] ?? undefined),
      name: asString((game as Record<string, unknown> | null)?.["name"] ?? undefined),
    }));

    const found = (
      matchedBy: GameResolution["matched_by"],
      game: { id: number | null; slug: string | null; name: string | null },
    ): GameResolution | null =>
      game.id === null
        ? null
        : { game_id: game.id, slug: game.slug, name: game.name, matched_by: matchedBy, games_visible: games.length };

    if (configuredSlug !== null) {
      const target = configuredSlug.toLowerCase();
      const hit = games.find((game) => game.slug?.toLowerCase() === target);
      const resolved = hit === undefined ? null : found("configured-slug", hit);
      if (resolved !== null) return resolved;
      throw new CurseForgeError(
        "GAME_UNRESOLVED",
        `CURSEFORGE_GAME_SLUG is set to ${JSON.stringify(configuredSlug)} but no game with that slug is ` +
          `visible to this API key. ${games.length} game(s) were returned by GET /v1/games. An explicitly ` +
          `configured slug is NOT silently fallen back on: you asked for a specific game, and searching for a ` +
          `different one would answer a question you did not ask. Visible slugs: ` +
          `${JSON.stringify(games.map((game) => game.slug).filter((slug) => slug !== null))}.`,
        {
          detail: {
            configured_slug: configuredSlug,
            games_visible: games.length,
            visible_slugs: games.map((game) => game.slug),
          },
        },
      );
    }

    for (const candidate of slugCandidates) {
      const hit = games.find((game) => game.slug?.toLowerCase() === candidate.toLowerCase());
      const resolved = hit === undefined ? null : found("candidate-slug", hit);
      if (resolved !== null) return resolved;
    }

    for (const candidate of nameCandidates) {
      const hit = games.find((game) => game.name?.toLowerCase().includes(candidate.toLowerCase()));
      const resolved = hit === undefined ? null : found("name-substring", hit);
      if (resolved !== null) return resolved;
    }

    // FAIL LOUDLY, naming what was searched for and how many games the key
    // returned. No fallback to a guessed integer, ever.
    throw new CurseForgeError(
      "GAME_UNRESOLVED",
      `ARK: Survival Ascended could not be found in the ${games.length} game(s) GET /v1/games returned for ` +
        `this API key. Searched for slug ${JSON.stringify(slugCandidates)} then for a name containing ` +
        `${JSON.stringify(nameCandidates)}. No fallback gameId is guessed, and that refusal is the point: ` +
        `gameId is a REQUIRED filter on /v1/mods/search, so a wrong one would not error — it would return a ` +
        `clean, empty, entirely wrong result set. Two possibilities, and they need different responses: (a) the ` +
        `slug candidates are wrong, which is ADR-002 §14.3 U1 and is fixed by setting CURSEFORGE_GAME_SLUG; ` +
        `(b) ASA is not visible to this key at all, which is U2 and is a v1-blocking discovery for the board ` +
        `rather than something to work around in code. Visible slugs: ` +
        `${JSON.stringify(games.map((game) => game.slug).filter((slug) => slug !== null))}.`,
      {
        detail: {
          games_visible: games.length,
          visible_slugs: games.map((game) => game.slug),
          searched_slugs: slugCandidates,
          searched_names: nameCandidates,
          unverified_rows: ["U1", "U2"],
        },
      },
    );
  };

  return {
    async resolve(): Promise<GameResolution> {
      if (cached !== null) return cached;
      // Share one in-flight attempt. Seven tools may be called concurrently and
      // the first thing each does is resolve; without this, the first turn after
      // startup spends seven requests answering the same question against an API
      // whose rate limit is undocumented.
      if (inFlight === null) {
        inFlight = attempt()
          .then((resolution) => {
            cached = resolution;
            lastError = null;
            return resolution;
          })
          .catch((error: unknown) => {
            lastError = error instanceof CurseForgeError ? error.message : String(error);
            throw error;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
    peek(): GameResolution | null {
      // Cached for the PROCESS LIFETIME only (§5). Nothing persists it: §10
      // forbids persisted state, and a stale gameId on disk would outlive the
      // key that could see the game.
      return cached;
    },
    lastError(): string | null {
      return lastError;
    },
  };
}

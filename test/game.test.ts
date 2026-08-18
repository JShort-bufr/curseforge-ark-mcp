import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createGameResolver } from "../src/game.js";
import { CurseForgeError } from "../src/errors.js";
import { FAKE_GAME_ID, FAKE_GAME_NAME, FAKE_GAME_SLUG, gamesBody, testClient } from "./fixtures.js";

/** ADR-002 §5 — capability detection over assumption. The gameId is never hardcoded and never guessed. */

const OTHER_GAME = { id: 432, slug: "some-other-game", name: "Some Other Game" };
/**
 * ARK: Survival EVOLVED, as a trap.
 *
 * A different game with a different mod catalog. A name match on "ark" would pick
 * it up and return results that look entirely plausible and are entirely wrong,
 * which is why the name candidates say "survival ascended".
 */
const WRONG_ARK = { id: 999, slug: "ark-survival-evolved", name: "ARK: Survival Evolved" };

function resolverFor(games: unknown[], configuredSlug: string | null = null) {
  const { client, calls } = testClient([{ match: /\/v1\/games/, method: "GET", body: gamesBody(games) }]);
  return { resolver: createGameResolver(client, { configuredSlug }), calls };
}

describe("§5 — resolution", () => {
  test("PREIMAGE: a matching slug resolves, and records HOW it matched", async () => {
    const { resolver } = resolverFor([OTHER_GAME, { id: FAKE_GAME_ID, slug: FAKE_GAME_SLUG, name: FAKE_GAME_NAME }]);
    const resolution = await resolver.resolve();
    assert.equal(resolution.game_id, FAKE_GAME_ID);
    assert.equal(resolution.matched_by, "candidate-slug");
    assert.equal(resolution.games_visible, 2);
  });

  test("a name substring resolves when no slug matched, and says it did so", async () => {
    const { resolver } = resolverFor([{ id: 3_003, slug: "unexpected-slug", name: "Ark Survival Ascended" }]);
    const resolution = await resolver.resolve();
    assert.equal(resolution.game_id, 3_003);
    assert.equal(resolution.matched_by, "name-substring");
  });

  test("ARK: Survival EVOLVED is NOT matched — it is a different game with a different catalog", async () => {
    const { resolver } = resolverFor([WRONG_ARK]);
    const error = await resolver.resolve().then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError, "resolving to Survival Evolved would be a confident wrong answer");
    assert.equal(error.code, "GAME_UNRESOLVED");
  });

  test("no match FAILS LOUDLY, naming what was searched and how many games the key returned", async () => {
    const { resolver } = resolverFor([OTHER_GAME, WRONG_ARK]);
    const error = await resolver.resolve().then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "GAME_UNRESOLVED");
    assert.equal(error.detail["games_visible"], 2);
    assert.deepEqual(error.detail["searched_slugs"], ["ark-survival-ascended", "arksa"]);
    assert.deepEqual(error.detail["unverified_rows"], ["U1", "U2"]);
    assert.match(error.message, /No fallback gameId is guessed/);
    // The two possibilities need different responses, so the message must name both.
    assert.match(error.message, /CURSEFORGE_GAME_SLUG/, "U1's fix");
    assert.match(error.message, /discovery for the board/, "U2's escalation");
  });

  test("an explicitly configured slug that does not match is NOT silently fallen back on", async () => {
    // The candidate list would have matched here. It must not be consulted: the
    // caller asked for a specific game, and answering about a different one would
    // answer a question nobody asked.
    const { resolver } = resolverFor(
      [{ id: FAKE_GAME_ID, slug: FAKE_GAME_SLUG, name: FAKE_GAME_NAME }],
      "some-slug-that-is-not-there",
    );
    const error = await resolver.resolve().then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "GAME_UNRESOLVED");
    assert.match(error.message, /NOT silently fallen back on/);
  });

  test("an empty game list is an honest failure, not an empty result", async () => {
    const { resolver } = resolverFor([]);
    const error = await resolver.resolve().then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.detail["games_visible"], 0);
  });
});

describe("§5 — caching is process-lifetime and per-resolver, not a module singleton", () => {
  test("a second resolve() issues no second request", async () => {
    const { resolver, calls } = resolverFor([{ id: FAKE_GAME_ID, slug: FAKE_GAME_SLUG, name: FAKE_GAME_NAME }]);
    await resolver.resolve();
    await resolver.resolve();
    assert.equal(calls.length, 1);
  });

  test("concurrent resolves share ONE in-flight request", async () => {
    const { resolver, calls } = resolverFor([{ id: FAKE_GAME_ID, slug: FAKE_GAME_SLUG, name: FAKE_GAME_NAME }]);
    const [a, b, c] = await Promise.all([resolver.resolve(), resolver.resolve(), resolver.resolve()]);
    assert.equal(calls.length, 1, "seven tools resolving on the first turn must not cost seven requests");
    assert.equal(a.game_id, b.game_id);
    assert.equal(b.game_id, c.game_id);
  });

  test("peek() reports nothing before resolution, and the failure is retained for diagnostics", async () => {
    const { resolver } = resolverFor([OTHER_GAME]);
    assert.equal(resolver.peek(), null);
    assert.equal(resolver.lastError(), null);
    await resolver.resolve().catch(() => undefined);
    assert.equal(resolver.peek(), null, "a failed resolution must not be cached as an answer");
    assert.match(String(resolver.lastError()), /could not be found/);
  });

  test("two resolvers do not share state — the cache is injected, not global", async () => {
    const first = resolverFor([{ id: 1_111, slug: FAKE_GAME_SLUG, name: FAKE_GAME_NAME }]);
    const second = resolverFor([{ id: 2_222, slug: FAKE_GAME_SLUG, name: FAKE_GAME_NAME }]);
    assert.equal((await first.resolver.resolve()).game_id, 1_111);
    assert.equal((await second.resolver.resolve()).game_id, 2_222);
  });
});

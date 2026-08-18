import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { assertPaginationBounds, MAX_ADDRESSABLE_RESULTS, MAX_PAGE_SIZE } from "../src/allowlist.js";
import { CurseForgeError } from "../src/errors.js";
import { standardRoutes, testClient } from "./fixtures.js";

/**
 * ADR-002 §4. Documented AND enforced client-side, tested with no key and no
 * network — these are argument validation and they run before `fetch`.
 *
 * §4.5 requires the same preimage discipline as §1.8, so every refusal here is
 * paired with a proof that the legal boundary value DOES dispatch.
 */

describe("§4.1 — pageSize over 50 is REFUSED, not clamped", () => {
  test("pageSize 200 is refused before dispatch, naming both numbers", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await client
      .request({ path: "v1/mods/search", query: { gameId: 1, pageSize: 200 }, tool: "search_mods" })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "ARGUMENT_REFUSED");
    assert.equal(calls.length, 0, "refused before dispatch");
    assert.match(error.message, /200/, "the message must name what was asked for");
    assert.match(error.message, new RegExp(String(MAX_PAGE_SIZE)), "and the bound");
    assert.match(
      error.message,
      /refused rather than clamped/,
      "a clamp would let a caller reason about a page as if it were the whole set",
    );
  });

  test("PREIMAGE: pageSize exactly 50 dispatches, so the refusal above is about being OVER the bound", async () => {
    const { client, calls } = testClient(standardRoutes());
    await client.request({
      path: "v1/mods/search",
      query: { gameId: 1, pageSize: MAX_PAGE_SIZE },
      tool: "search_mods",
    });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0]?.url), new RegExp(`pageSize=${MAX_PAGE_SIZE}`));
  });

  test("nothing is clamped: the dispatched URL carries the value the caller asked for", async () => {
    const { client, calls } = testClient(standardRoutes());
    await client.request({ path: "v1/mods/search", query: { gameId: 1, pageSize: 7 }, tool: "search_mods" });
    assert.match(String(calls[0]?.url), /pageSize=7/);
  });

  test("pageSize 0 and negative are refused", () => {
    assert.throws(() => assertPaginationBounds(0, 0), /at least 1/);
    assert.throws(() => assertPaginationBounds(0, -5), /at least 1/);
  });
});

describe("§4.2 — index + pageSize > 10000 is REFUSED, with the largest legal pageSize named", () => {
  test("index 9990 + pageSize 50 is refused and names 10 as the largest legal size", () => {
    const error = (() => {
      try {
        assertPaginationBounds(9_990, 50);
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "ARGUMENT_REFUSED");
    assert.match(error.message, new RegExp(String(MAX_ADDRESSABLE_RESULTS)), "the ceiling must be named");
    assert.match(error.message, /largest legal pageSize at index 9990 is 10/);
    assert.equal(error.detail["largest_legal_page_size_at_this_index"], 10);
  });

  test("PREIMAGE: index 9990 + pageSize 10 is exactly at the ceiling and is allowed", async () => {
    assert.doesNotThrow(() => assertPaginationBounds(9_990, 10));
    const { client, calls } = testClient(standardRoutes());
    await client.request({
      path: "v1/mods/search",
      query: { gameId: 1, index: 9_990, pageSize: 10 },
      tool: "search_mods",
    });
    assert.equal(calls.length, 1, "the constraint is <=, so the boundary value must work");
  });

  test("an index at or past the ceiling says so, and advises narrowing rather than paging", () => {
    const error = (() => {
      try {
        assertPaginationBounds(MAX_ADDRESSABLE_RESULTS, 1);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    assert.ok(error instanceof CurseForgeError);
    assert.match(error.message, /not addressable through this API at all/);
    assert.match(error.message, /narrow the filter/);
    assert.equal(error.detail["largest_legal_page_size_at_this_index"], 0);
  });

  test("a negative index is refused", () => {
    assert.throws(() => assertPaginationBounds(-1, 10), /at least 0/);
  });
});

describe("§4.3 — when totalCount exceeds the window, the tool says the tail is UNREACHABLE", () => {
  test("a search over the ceiling reports tail_unreachable and says the words", async () => {
    const { client } = testClient([
      {
        match: /\/v1\/mods\/search/,
        method: "GET",
        body: { data: [], pagination: { index: 0, pageSize: 50, resultCount: 50, totalCount: 12_345 } },
      },
    ]);
    const { page } = await client.request({
      path: "v1/mods/search",
      query: { gameId: 1, pageSize: 50 },
      tool: "search_mods",
    });
    assert.equal(page?.tail_unreachable, true);
    assert.equal(page?.total_count, 12_345);
  });

  test("PREIMAGE: a totalCount under the ceiling is NOT flagged", async () => {
    const { client } = testClient([
      {
        match: /\/v1\/mods\/search/,
        method: "GET",
        body: { data: [], pagination: { index: 0, pageSize: 50, resultCount: 50, totalCount: 120 } },
      },
    ]);
    const { page } = await client.request({ path: "v1/mods/search", query: { gameId: 1 }, tool: "search_mods" });
    assert.equal(page?.tail_unreachable, false, "otherwise the flag above would be unconditional and meaningless");
  });
});

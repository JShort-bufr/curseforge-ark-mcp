import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { CurseForgeClient, type RateLimitSnapshot } from "../src/client.js";
import { CurseForgeError } from "../src/errors.js";
import { fileRecord, modRecord, pagination, standardRoutes, testClient, testConfig } from "./fixtures.js";

/** ADR-002 §3 — the { data, pagination } envelope, unwrapped in exactly one place. */

describe("§3 — `data` is unwrapped once, in the transport", () => {
  test("PREIMAGE: a well-formed envelope yields the inner data and nothing else", async () => {
    const { client } = testClient(standardRoutes());
    const { data, page } = await client.request({ path: `v1/mods/777001`, tool: "get_mod" });
    assert.deepEqual(data, modRecord(), "tools receive `data`, never the envelope");
    assert.equal(page, null, "E3 is a single-record endpoint: no pagination, and none is synthesised");
  });

  test("`data` ABSENT is an ERROR, not an empty result", async () => {
    const { client } = testClient([{ match: /\/v1\/mods\/\d+$/, method: "GET", body: { pagination: pagination(0, 0) } }]);
    const error = await client.request({ path: "v1/mods/777001", tool: "get_mod" }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "UPSTREAM_SHAPE");
    assert.match(error.message, /confident wrong answer/);
    assert.deepEqual(error.detail["keys_present"], ["pagination"]);
  });

  test("`data: []` is NOT an error — it is a real answer meaning 'none matched'", async () => {
    const { client } = testClient([
      { match: /\/v1\/mods\/search/, method: "GET", body: { data: [], pagination: pagination(0, 0) } },
    ]);
    const { data } = await client.request({ path: "v1/mods/search", query: { gameId: 1 }, tool: "search_mods" });
    assert.deepEqual(data, [], "empty is not unknown (§6)");
  });

  test("`data: null` is preserved rather than coerced — absent is not empty", async () => {
    const { client } = testClient([{ match: /\/v1\/mods\/\d+$/, method: "GET", body: { data: null } }]);
    const { data } = await client.request({ path: "v1/mods/777001", tool: "get_mod" });
    assert.equal(data, null);
  });
});

describe("§3 — pagination presence rules differ by endpoint kind", () => {
  test("pagination ABSENT on a paginated endpoint is an ERROR — one page is never assumed", async () => {
    const { client } = testClient([{ match: /\/v1\/games/, method: "GET", body: { data: [] } }]);
    const error = await client.request({ path: "v1/games", tool: "get_api_diagnostics" }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "UPSTREAM_SHAPE");
    assert.match(error.message, /does NOT assume one page/);
    assert.match(error.message, /50 of 900 mods/, "the reason must travel with the refusal");
    assert.equal(error.detail["unverified_row"], "U8", "and it must point at the open question it belongs to");
  });

  test("PREIMAGE: the same endpoint WITH pagination succeeds", async () => {
    const { client } = testClient(standardRoutes());
    const { page } = await client.request({ path: "v1/games", tool: "get_api_diagnostics" });
    assert.equal(page?.index, 0);
  });

  test("pagination absent on a single-record endpoint is NORMAL", async () => {
    const { client } = testClient([
      { match: /\/v1\/mods\/\d+\/files\/\d+$/, method: "GET", body: { data: fileRecord() } },
    ]);
    const { page } = await client.request({ path: "v1/mods/777001/files/555001", tool: "get_mod_file" });
    assert.equal(page, null);
  });

  test("pagination absent on a bulk read is NORMAL", async () => {
    const { client } = testClient(standardRoutes());
    const { page } = await client.request({
      method: "POST",
      path: "v1/mods",
      body: { modIds: [777_001] },
      tool: "resolve_mod_dependencies",
    });
    assert.equal(page, null);
  });
});

describe("§3 — the page descriptor is surfaced, and its numbers are never invented", () => {
  test("has_more is computed from index + resultCount vs totalCount", async () => {
    const { client } = testClient([
      {
        match: /\/v1\/mods\/search/,
        method: "GET",
        body: { data: [], pagination: { index: 0, pageSize: 50, resultCount: 50, totalCount: 900 } },
      },
    ]);
    const { page } = await client.request({ path: "v1/mods/search", query: { gameId: 1 }, tool: "search_mods" });
    assert.equal(page?.has_more, true);
    assert.equal(page?.result_count, 50);
    assert.equal(page?.total_count, 900);
  });

  test("has_more is FALSE on a complete set, not null", async () => {
    const { client } = testClient([
      {
        match: /\/v1\/mods\/search/,
        method: "GET",
        body: { data: [], pagination: { index: 0, pageSize: 50, resultCount: 12, totalCount: 12 } },
      },
    ]);
    const { page } = await client.request({ path: "v1/mods/search", query: { gameId: 1 }, tool: "search_mods" });
    assert.equal(page?.has_more, false);
  });

  test("a missing pagination number stays null and makes has_more null — NEVER 0, never false", async () => {
    const { client } = testClient([
      {
        match: /\/v1\/mods\/search/,
        method: "GET",
        body: { data: [], pagination: { index: 0, pageSize: 50, resultCount: 50 } },
      },
    ]);
    const { page } = await client.request({ path: "v1/mods/search", query: { gameId: 1 }, tool: "search_mods" });
    assert.equal(page?.total_count, null, "absent is not zero");
    assert.equal(page?.has_more, null, "and it is not 'no more results', which is what false would claim");
    assert.equal(page?.tail_unreachable, null);
  });
});

describe("upstream failures", () => {
  test("a non-2xx becomes a coded error naming method, path and status — and NO headers", async () => {
    const { client, config } = testClient([
      { match: /\/v1\/games/, method: "GET", status: 401, body: { error: "nope" } },
    ]);
    const error = await client.request({ path: "v1/games", tool: "get_api_diagnostics" }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "AUTH_INVALID");
    assert.equal(error.httpStatus, 401);
    const rendered = JSON.stringify(error.toPayload());
    assert.equal(rendered.includes(config.apiKey), false, "the key must never reach an error payload");
    assert.equal(rendered.includes("x-api-key"), false, "and neither must the header name (§12.1)");
  });

  test("a 429 refuses to invent a wait time, because no quota is published", async () => {
    const { client } = testClient([{ match: /\/v1\/games/, method: "GET", status: 429, body: {} }]);
    const error = await client.request({ path: "v1/games", tool: "get_api_diagnostics" }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "RATE_LIMITED");
    assert.match(error.message, /publishes NO rate-limit figure/);
  });

  test("a 200 carrying non-JSON becomes UPSTREAM with a bounded, scrubbed snippet", async () => {
    // A proxy or a maintenance page answering 200 with HTML is the real shape of
    // this failure, so the stub answers exactly that rather than a JSON error.
    const client = new CurseForgeClient(testConfig(), async () =>
      new Response(`<html>gateway timeout ${"x".repeat(1_000)}</html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const error = await client.request({ path: "v1/games", tool: "get_api_diagnostics" }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "UPSTREAM");
    assert.ok(
      String(error.detail["body_snippet"]).length <= 300,
      "an unbounded upstream string in a model's context is its own problem",
    );
  });

  test("rate-limit headers are captured RAW when present, and null when not", async () => {
    const { client: withHeaders } = testClient([
      {
        match: /\/v1\/games/,
        method: "GET",
        body: { data: [], pagination: pagination(0, 0) },
        headers: { "x-ratelimit-remaining": "17" },
      },
    ]);
    // Asserted through a helper so the null check does not narrow the getter for
    // the rest of the test — the point of the pair is that BOTH readings happen.
    const snapshot = (client: { lastRateLimit: RateLimitSnapshot | null }): RateLimitSnapshot | null =>
      client.lastRateLimit;

    assert.equal(snapshot(withHeaders), null, "null before any call — absent is not zero");
    await withHeaders.request({ path: "v1/games", tool: "get_api_diagnostics" });
    assert.deepEqual(
      snapshot(withHeaders)?.headers,
      { "x-ratelimit-remaining": "17" },
      "raw, unparsed — no invented { limit, remaining } shape",
    );

    const { client: without } = testClient(standardRoutes());
    await without.request({ path: "v1/games", tool: "get_api_diagnostics" });
    assert.equal(
      snapshot(without),
      null,
      "no header means no observation, which is NOT a claim that there is no limit",
    );
  });
});

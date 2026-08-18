import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  ENDPOINT_ALLOWLIST,
  matchEndpoint,
  MAX_BULK_IDS,
  normalizePath,
  PINNED_ORIGIN,
  POST_CAPABLE_TOOLS,
} from "../src/allowlist.js";
import { CurseForgeError } from "../src/errors.js";
import {
  FAKE_DEP_MOD_ID,
  FAKE_FILE_ID,
  FAKE_MOD_ID,
  standardRoutes,
  testClient,
  type RecordedCall,
} from "./fixtures.js";

/**
 * ADR-002 §1.8. The nine required tests, in the ADR's own order, against an
 * injected fake `fetch` with no API key and no network.
 *
 * TEST 1 IS THE PREIMAGE and it comes first, because it is what makes tests 2-9
 * mean anything: a refusal suite over a client that can dispatch nothing passes
 * perfectly and proves nothing. Every refusal test below asserts on the fake's
 * CALL COUNT, not merely on the thrown error — "refused before the request is
 * built" is the provision, and an error thrown after dispatch would satisfy a
 * weaker assertion.
 */

/** Every refusal assertion goes through here, so none of them can forget the call-count half. */
async function assertRefusedBeforeDispatch(
  label: string,
  calls: RecordedCall[],
  action: () => Promise<unknown>,
): Promise<CurseForgeError> {
  const before = calls.length;
  const error = await action().then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof CurseForgeError, `${label}: expected a CurseForgeError, got ${String(error)}`);
  assert.equal(
    calls.length,
    before,
    `${label}: fetch was called ${calls.length - before} time(s). The provision is "refused BEFORE the request ` +
      `is built", so a refusal that still dispatched is a failure even though it threw.`,
  );
  return error;
}

// ---------------------------------------------------------------------------
// TEST 1 — THE PREIMAGE. Each of E1-E7 is dispatched.
// ---------------------------------------------------------------------------

describe("§1.8 test 1 — the preimage: all seven entries DO dispatch", () => {
  test("E1..E7 each reach fetch, against the SHIPPED allow-list", async () => {
    const { client, calls } = testClient(standardRoutes());

    await client.request({ path: "v1/games", tool: "get_api_diagnostics" });
    await client.request({ path: "v1/mods/search", query: { gameId: 1 }, tool: "search_mods" });
    await client.request({ path: `v1/mods/${FAKE_MOD_ID}`, tool: "get_mod" });
    await client.request({ path: `v1/mods/${FAKE_MOD_ID}/files`, tool: "list_mod_files" });
    await client.request({ path: `v1/mods/${FAKE_MOD_ID}/files/${FAKE_FILE_ID}`, tool: "get_mod_file" });
    await client.request({
      method: "POST",
      path: "v1/mods",
      body: { modIds: [FAKE_MOD_ID] },
      tool: "resolve_mod_dependencies",
    });
    await client.request({
      method: "POST",
      path: "v1/mods/files",
      body: { fileIds: [FAKE_FILE_ID] },
      tool: "resolve_mod_dependencies",
    });

    assert.equal(calls.length, 7, "all seven entries must be dispatchable, or every refusal below is vacuous");
    assert.equal(calls.filter((call) => call.method === "POST").length, 2, "exactly two entries carry POST");
    for (const call of calls) {
      assert.ok(call.url.startsWith(PINNED_ORIGIN), `dispatched to an unexpected origin: ${call.url}`);
    }
  });

  test("the credential is attached, as x-api-key and NOT as Authorization", async () => {
    const { client, calls, config } = testClient(standardRoutes());
    await client.request({ path: "v1/games", tool: "get_api_diagnostics" });

    const call = calls[0];
    assert.ok(call);
    assert.equal(call.headers["x-api-key"], config.apiKey);
    assert.equal(
      call.headers["authorization"],
      undefined,
      "Authorization: Bearer is the sibling repo's Nitrado scheme and must not appear here",
    );
  });
});

// ---------------------------------------------------------------------------
// TEST 5 — THE ACCEPTANCE TEST, written second only because the preimage must
// come first. This is the one that proves this is an allow-list.
// ---------------------------------------------------------------------------

describe("§1.8 test 5 — THE ACCEPTANCE TEST: download-url is refused", () => {
  test("GET /v1/mods/{id}/files/{id}/download-url is REFUSED — a documented read, on the pinned host, not on the list", async () => {
    const { client, calls } = testClient(standardRoutes());

    const error = await assertRefusedBeforeDispatch("download-url", calls, () =>
      client.request({ path: `v1/mods/${FAKE_MOD_ID}/files/${FAKE_FILE_ID}/download-url`, tool: "get_mod_file" }),
    );

    // The code and the detail together are what prove it was refused for the
    // RIGHT reason. A GET, on api.curseforge.com, with a valid numeric mod id and
    // file id — every property except "is it on the list".
    assert.equal(error.code, "ENDPOINT_NOT_ALLOWED");
    assert.equal(
      error.detail["allowlist_size"],
      ENDPOINT_ALLOWLIST.length,
      "must be the allow-list refusal specifically, not the §8 POST-capability refusal or a host-pin refusal",
    );
    assert.notEqual(error.code, "HOST_NOT_ALLOWED", "it is on the pinned host — that is the whole point");
    assert.notEqual(error.code, "PATH_REFUSED", "the path is well-formed — that is also the whole point");

    // And the sibling GET on the SAME path prefix does dispatch, so the refusal
    // above is about the extra segment and not about the prefix being unreachable.
    await client.request({ path: `v1/mods/${FAKE_MOD_ID}/files/${FAKE_FILE_ID}`, tool: "get_mod_file" });
    assert.equal(calls.length, 1, "E5 on the same prefix must still work");
  });
});

// ---------------------------------------------------------------------------
// TESTS 2, 3, 4 — method/path pairing.
// ---------------------------------------------------------------------------

describe("§1.8 tests 2-4 — {method, path} are matched JOINTLY", () => {
  test("test 2: DELETE /v1/mods/123 is refused before fetch is called", async () => {
    const { client, calls } = testClient(standardRoutes());
    // `method` is typed as GET|POST, so a DELETE is not even spellable through the
    // public API — the type is the first control. Cast past it to prove the
    // RUNTIME control exists too, because a type is not present at runtime and the
    // string could arrive from anywhere.
    const error = await assertRefusedBeforeDispatch("DELETE", calls, () =>
      client.request({ method: "DELETE" as unknown as "GET", path: `v1/mods/${FAKE_MOD_ID}` }),
    );
    assert.equal(error.code, "ENDPOINT_NOT_ALLOWED");
    assert.equal(error.detail["method"], "DELETE");
  });

  test("test 3: POST /v1/mods/123 is refused — right path family, wrong method pairing", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("POST to E3's path", calls, () =>
      client.request({
        method: "POST",
        path: `v1/mods/${FAKE_MOD_ID}`,
        body: { modIds: [1] },
        // The one POST-capable tool, so a §8 refusal cannot be what passes this test.
        tool: "resolve_mod_dependencies",
      }),
    );
    assert.equal(error.code, "ENDPOINT_NOT_ALLOWED");
    assert.equal(
      error.detail["allowlist_size"],
      ENDPOINT_ALLOWLIST.length,
      "E6's POST /v1/mods must not authorise POST /v1/mods/123",
    );
  });

  test("test 4: POST /v1/mods/search is refused — right path, wrong method", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("POST to E2's path", calls, () =>
      client.request({
        method: "POST",
        path: "v1/mods/search",
        body: { modIds: [1] },
        tool: "resolve_mod_dependencies",
      }),
    );
    assert.equal(error.code, "ENDPOINT_NOT_ALLOWED");
    assert.equal(error.detail["allowlist_size"], ENDPOINT_ALLOWLIST.length);
  });
});

// ---------------------------------------------------------------------------
// TEST 6 — the host pin.
// ---------------------------------------------------------------------------

describe("§1.8 test 6 — the host is pinned", () => {
  test("an otherwise well-formed /v1/mods/search on another host is refused", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("other host", calls, () =>
      client.request({ path: "https://mods.example.invalid/v1/mods/search", tool: "search_mods" }),
    );
    assert.equal(error.code, "HOST_NOT_ALLOWED");
    assert.equal(error.detail["attempted_origin"], "https://mods.example.invalid");
    assert.equal(error.detail["pinned_origin"], PINNED_ORIGIN);
  });

  test("a mutating-shaped upload POST on another host is refused TWICE over — host first", async () => {
    // ADR-002 §14.2's finding, as a test. Under a relaxed {GET, POST} method gate
    // nothing about this request's METHOD distinguishes it from POST /v1/mods.
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("upload API", calls, () =>
      client.request({
        method: "POST",
        path: "https://minecraft.example.invalid/api/projects/123/upload-file",
        body: { modIds: [1] },
        tool: "resolve_mod_dependencies",
      }),
    );
    assert.equal(error.code, "HOST_NOT_ALLOWED");

    // Second, independent reason: even ON the pinned host that path has no entry.
    const second = await assertRefusedBeforeDispatch("upload path on pinned host", calls, () =>
      client.request({
        method: "POST",
        path: "api/projects/123/upload-file",
        body: { modIds: [1] },
        tool: "resolve_mod_dependencies",
      }),
    );
    assert.equal(second.code, "ENDPOINT_NOT_ALLOWED");
  });

  test("a protocol-relative path is refused rather than resolved against the pin", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("protocol-relative", calls, () =>
      client.request({ path: "//mods.example.invalid/v1/mods/search", tool: "search_mods" }),
    );
    assert.equal(error.code, "HOST_NOT_ALLOWED");
  });
});

// ---------------------------------------------------------------------------
// TEST 7 — normalization.
// ---------------------------------------------------------------------------

describe("§1.8 test 7 — one normalization, before the check", () => {
  test("v1/mods/../games is refused", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("traversal", calls, () =>
      client.request({ path: "v1/mods/../games", tool: "get_api_diagnostics" }),
    );
    assert.equal(error.code, "PATH_REFUSED");
  });

  test("v1/mods/%252e%252e/games is refused — the double-encoding case that broke the original rule", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("double-encoded traversal", calls, () =>
      client.request({ path: "v1/mods/%252e%252e/games", tool: "get_api_diagnostics" }),
    );
    assert.equal(error.code, "PATH_REFUSED");
    assert.match(error.message, /multiply encoded/);
  });

  test("the preimage for the two above: the same shape WITHOUT the escape dispatches", async () => {
    // Without this, both tests above could be passing because nothing resolves.
    const { client, calls } = testClient(standardRoutes());
    await client.request({ path: "v1/games", tool: "get_api_diagnostics" });
    assert.equal(calls.length, 1);
  });

  test("backslashes are folded before the check, because this runs on Windows", () => {
    assert.throws(() => normalizePath("v1\\mods\\..\\games"), /`\.\.` segment/);
  });

  test("empty and dot segments are refused rather than resolved", () => {
    assert.throws(() => normalizePath("v1//games"), /empty segment/);
    assert.throws(() => normalizePath("v1/./games"), /`\.` segment/);
    assert.throws(() => normalizePath("   "), /empty once leading separators/);
  });

  test("a legal path survives normalization unchanged apart from the leading slash", () => {
    assert.equal(normalizePath("/v1/mods/123/files"), "v1/mods/123/files");
  });
});

// ---------------------------------------------------------------------------
// TEST 8 — a GET entry with a body.
// ---------------------------------------------------------------------------

describe("§1.8 test 8 — a body on a GET entry is refused, not dropped", () => {
  test("GET /v1/mods/search with a body is refused", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("GET with body", calls, () =>
      client.request({ path: "v1/mods/search", body: { modIds: [1] }, tool: "search_mods" }),
    );
    assert.equal(error.code, "ARGUMENT_REFUSED");
    assert.match(error.message, /refused rather than dropped/);
  });

  test("a bulk entry called WITHOUT a body is refused too", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("POST without body", calls, () =>
      client.request({ method: "POST", path: "v1/mods", tool: "resolve_mod_dependencies" }),
    );
    assert.equal(error.code, "ARGUMENT_REFUSED");
  });
});

// ---------------------------------------------------------------------------
// TEST 9 — bulk body shape check.
// ---------------------------------------------------------------------------

describe("§1.8 test 9 — E6/E7 bodies are shape-checked before dispatch", () => {
  const bad: Array<[string, unknown]> = [
    ["a string id", { modIds: ["1; DROP"] }],
    ["an empty array", { modIds: [] }],
    ["a negative id", { modIds: [-1] }],
    ["a non-integer id", { modIds: [1.5] }],
    ["the wrong key", { fileIds: [1] }],
    ["an extra key", { modIds: [1], extra: true }],
    ["not an object", [1, 2, 3]],
    ["an over-cap array", { modIds: Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => i) }],
  ];

  for (const [label, body] of bad) {
    test(`E6 with ${label} is refused before dispatch`, async () => {
      const { client, calls } = testClient(standardRoutes());
      const error = await assertRefusedBeforeDispatch(label, calls, () =>
        client.request({
          method: "POST",
          path: "v1/mods",
          body: body as Record<string, unknown>,
          tool: "resolve_mod_dependencies",
        }),
      );
      assert.equal(error.code, "ARGUMENT_REFUSED");
    });
  }

  test("the preimage: a well-formed E6 body at exactly the cap DOES dispatch", async () => {
    const { client, calls } = testClient(standardRoutes());
    await client.request({
      method: "POST",
      path: "v1/mods",
      body: { modIds: Array.from({ length: MAX_BULK_IDS }, (_, i) => i + 1) },
      tool: "resolve_mod_dependencies",
    });
    assert.equal(calls.length, 1, "the cap is inclusive, so the refusals above are about being OVER it");
    assert.equal(calls[0]?.headers["content-type"], "application/json");
  });
});

// ---------------------------------------------------------------------------
// The numeric id binding, and §8.
// ---------------------------------------------------------------------------

describe("§1.6 — id segments bind to [0-9]+, not [^/]+", () => {
  test("E3's pattern does NOT match /v1/mods/search", () => {
    const e3 = ENDPOINT_ALLOWLIST.find((entry) => entry.id === "E3");
    assert.ok(e3);
    assert.equal(
      e3.pattern.test("v1/mods/search"),
      false,
      "a permissive {modId} would make E3 swallow E2's path, which is the ambiguity the numeric binding removes",
    );
    assert.equal(e3.pattern.test("v1/mods/anything"), false);
    assert.equal(e3.pattern.test("v1/mods/123"), true, "preimage: it does match a numeric id");
  });

  test("the E2/E3 disambiguation does NOT depend on match order", () => {
    // Reverse the whole list. If correctness rested on "first match wins" this
    // would now route /v1/mods/search to E3. It must still be E2.
    const reversed = [...ENDPOINT_ALLOWLIST].reverse();
    assert.equal(matchEndpoint("GET", "v1/mods/search", reversed)?.id, "E2");
    assert.equal(matchEndpoint("GET", "v1/mods/123", reversed)?.id, "E3");
    // And the shipped order agrees, so ordering is deterministic AND redundant.
    assert.equal(matchEndpoint("GET", "v1/mods/search")?.id, "E2");
  });

  test("E4/E5 do not match each other's arity", () => {
    assert.equal(matchEndpoint("GET", "v1/mods/1/files")?.id, "E4");
    assert.equal(matchEndpoint("GET", "v1/mods/1/files/2")?.id, "E5");
    assert.equal(matchEndpoint("GET", "v1/mods/1/files/2/3"), null);
  });

  test("the list is exactly the seven entries the ADR names, and nothing has been added quietly", () => {
    assert.deepEqual(
      ENDPOINT_ALLOWLIST.map((entry) => `${entry.id} ${entry.method} ${entry.pattern.source}`),
      // `RegExp.prototype.source` escapes forward slashes, so these are the
      // patterns as the engine reports them, not as they are written.
      [
        String.raw`E1 GET ^v1\/games$`,
        String.raw`E2 GET ^v1\/mods\/search$`,
        String.raw`E3 GET ^v1\/mods\/[0-9]+$`,
        String.raw`E4 GET ^v1\/mods\/[0-9]+\/files$`,
        String.raw`E5 GET ^v1\/mods\/[0-9]+\/files\/[0-9]+$`,
        String.raw`E6 POST ^v1\/mods$`,
        String.raw`E7 POST ^v1\/mods\/files$`,
      ],
    );
  });

  test("no entry uses a mutating method — the list itself is the read-only property", () => {
    for (const entry of ENDPOINT_ALLOWLIST) {
      assert.ok(entry.method === "GET" || entry.method === "POST", `${entry.id} declares ${entry.method}`);
    }
  });
});

describe("§8 — only resolve_mod_dependencies may issue a POST", () => {
  test("exactly two entries carry POST and exactly one tool may reach them", () => {
    assert.equal(ENDPOINT_ALLOWLIST.filter((entry) => entry.method === "POST").length, 2);
    assert.deepEqual(POST_CAPABLE_TOOLS, ["resolve_mod_dependencies"]);
  });

  test("another tool's POST is refused before dispatch, even with a valid body", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("wrong tool POSTing", calls, () =>
      client.request({
        method: "POST",
        path: "v1/mods",
        body: { modIds: [FAKE_DEP_MOD_ID] },
        tool: "search_mods",
      }),
    );
    assert.equal(error.code, "ENDPOINT_NOT_ALLOWED");
    assert.deepEqual(error.detail["post_capable_tools"], POST_CAPABLE_TOOLS);
  });

  test("a POST with NO declared tool is refused", async () => {
    const { client, calls } = testClient(standardRoutes());
    const error = await assertRefusedBeforeDispatch("anonymous POST", calls, () =>
      client.request({ method: "POST", path: "v1/mods", body: { modIds: [1] } }),
    );
    assert.equal(error.code, "ENDPOINT_NOT_ALLOWED");
    assert.match(error.message, /no tool at all/);
  });
});

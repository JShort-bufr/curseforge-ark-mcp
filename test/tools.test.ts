import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { CurseForgeClient, type FetchLike } from "../src/client.js";
import { CurseForgeError } from "../src/errors.js";
import { createGameResolver } from "../src/game.js";
import { MAX_DEPTH, MAX_NODES } from "../src/tools/dependencies.js";
import { allTools } from "../src/tools/index.js";
import type { ToolDef } from "../src/registry.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  FAKE_DEEP_MOD_ID,
  FAKE_DOWNLOAD_URL_MARKER,
  FAKE_DEP_MOD_ID,
  FAKE_FILE_ID,
  FAKE_GAME_ID,
  FAKE_GAME_VERSION,
  FAKE_MOD_ID,
  FAKE_OLDER_FILE_ID,
  FAKE_OTHER_RELEASE_TYPE,
  FAKE_RELATION_TYPE,
  FAKE_RELEASE_TYPE,
  FILE_FIELD_PREIMAGE,
  MOD_FIELD_PREIMAGE,
  fileRecord,
  jsonResponse,
  makeContext,
  modRecord,
  pagination,
  readPath,
  repoRoot,
  standardRoutes,
  testConfig,
  type StubRoute,
} from "./fixtures.js";

/**
 * The seven tools (ADR-002 §7), against an injected fake `fetch`.
 *
 * FIELD-PATH TESTS ARE PREIMAGE-GATED. Each asserts first that the fixture
 * actually contains the path, then that the tool read it. Without the first half a
 * field-path suite over an empty object passes perfectly — and these paths are all
 * hypotheses (§13), so the suite proves this client handles the shape it was
 * written for and nothing whatever about what CurseForge sends.
 */

/** Every .ts under src/, resolved from the repo root because tests run from dist/test. */
function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts")) out.push(readFileSync(child, "utf8"));
    }
  };
  walk(join(repoRoot(), "src"));
  assert.ok(out.length >= 10, `preimage: expected the src tree, got ${out.length} file(s)`);
  return out;
}

async function callTool(name: string, args: Record<string, unknown> = {}, routes: StubRoute[] = standardRoutes()) {
  const { ctx, calls } = makeContext(routes);
  const tool = allTools(ctx).find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} is not registered`);
  return { result: (await tool.handler(args)) as Record<string, unknown>, calls, tool: tool as ToolDef };
}

// ---------------------------------------------------------------------------
// Field paths (U3, U4, U5)
// ---------------------------------------------------------------------------

describe("§14.3 U3/U4/U5 — field paths, preimage-gated", () => {
  test("PREIMAGE: the Mod fixture actually contains every path the shaper reads", () => {
    const fixture = modRecord();
    assert.ok(MOD_FIELD_PREIMAGE.length >= 10, "an empty preimage list would make this vacuous");
    for (const path of MOD_FIELD_PREIMAGE) {
      assert.notEqual(readPath(fixture, path), undefined, `fixture is missing ${path}`);
    }
  });

  test("PREIMAGE: the File fixture actually contains every path the shaper reads", () => {
    const fixture = fileRecord();
    assert.ok(FILE_FIELD_PREIMAGE.length >= 10);
    for (const path of FILE_FIELD_PREIMAGE) {
      assert.notEqual(readPath(fixture, path), undefined, `fixture is missing ${path}`);
    }
  });

  test("get_mod reads the Mod paths through to its output", async () => {
    const { result } = await callTool("get_mod", { mod_id: FAKE_MOD_ID });
    const mod = result["mod"] as Record<string, unknown>;
    assert.equal(mod["id"], FAKE_MOD_ID);
    assert.equal(mod["game_id"], FAKE_GAME_ID);
    assert.equal(mod["name"], "Synthetic Structures Plus");
    assert.equal(mod["slug"], "synthetic-structures-plus");
    assert.equal(mod["website_url"], "https://example.invalid/synthetic-mod");
    assert.equal(mod["allow_mod_distribution"], true);
    assert.equal((mod["latest_files"] as unknown[]).length, 1);
    assert.ok(Array.isArray(mod["latest_files_indexes"]));
    assert.match(String(mod["field_paths"]), /confirmed against live responses 2026-08-18/);
    assert.match(
      String(mod["field_paths"]),
      /Still unconfirmed/,
      "the caveat must survive partial verification — some rows resolved, not all",
    );
  });

  test("get_mod_file reads the File paths, and says there is no download URL", async () => {
    const { result } = await callTool("get_mod_file", { mod_id: FAKE_MOD_ID, file_id: FAKE_FILE_ID });
    const file = result["file"] as Record<string, unknown>;
    assert.equal(file["id"], FAKE_FILE_ID);
    assert.equal(file["mod_id"], FAKE_MOD_ID);
    assert.equal(file["display_name"], "Synthetic Mod v2.1");
    assert.equal(file["file_name"], "synthetic-mod-2.1.zip");
    assert.equal(file["file_date"], "2026-08-10T12:00:00Z");
    assert.equal(file["is_available"], true);
    assert.deepEqual(file["game_versions"], [FAKE_GAME_VERSION]);
    assert.ok(Array.isArray(file["sortable_game_versions"]));
    assert.match(String(result["download_url_note"]), /not on the endpoint allow-list/);
  });

  test("a missing field becomes null, NOT 0 / \"\" / [] (§6)", async () => {
    const { result } = await callTool("get_mod", { mod_id: FAKE_MOD_ID }, [
      // A record carrying only an id. Structurally the documented shape, minus
      // every optional field — which is how a wrong field path LOOKS.
      { match: /\/v1\/games/, method: "GET", body: { data: [{ id: FAKE_GAME_ID, slug: "ark-survival-ascended" }], pagination: pagination(1, 1) } },
      { match: /\/v1\/mods\/\d+$/, method: "GET", body: { data: { id: FAKE_MOD_ID } } },
    ]);
    const mod = result["mod"] as Record<string, unknown>;
    assert.equal(mod["name"], null);
    assert.equal(mod["website_url"], null);
    assert.equal(mod["allow_mod_distribution"], null, "not false — absent is not 'distribution disallowed'");
    assert.equal(mod["latest_files_indexes"], null, "not [] — absent is not 'no indexes'");
    assert.deepEqual(mod["latest_files"], [], "latestFiles absent yields no files to shape, which is a real []");
  });

  test("release and relation integers are surfaced RAW and never mapped", async () => {
    const { result } = await callTool("get_mod_file", { mod_id: FAKE_MOD_ID, file_id: FAKE_FILE_ID });
    const file = result["file"] as Record<string, unknown>;
    assert.equal(file["release_type_raw"], FAKE_RELEASE_TYPE);
    assert.match(String(file["release_type_note"]), /NOT mapped/);
    assert.deepEqual(file["dependencies"], [
      { mod_id: FAKE_DEP_MOD_ID, relation_type_raw: FAKE_RELATION_TYPE },
    ]);
    // No labelled field anywhere: a mapping would have to appear as one.
    const rendered = JSON.stringify(result);
    for (const label of ['"release"', '"alpha"', '"beta"', '"required"', '"optional"', '"incompatible"']) {
      assert.equal(rendered.includes(label), false, `${label} implies a mapping this repo refuses to invent`);
    }
  });

  test("dependencies ABSENT is null, dependencies EMPTY is [] — U9 needs them told apart", async () => {
    const { result } = await callTool("get_mod_file", { mod_id: FAKE_MOD_ID, file_id: 1 }, [
      { match: /\/v1\/games/, method: "GET", body: { data: [{ id: 1, slug: "ark-survival-ascended" }], pagination: pagination(1, 1) } },
      { match: /files\/\d+$/, method: "GET", body: { data: { id: 1, modId: 2 } } },
    ]);
    assert.equal((result["file"] as Record<string, unknown>)["dependencies"], null);

    const { result: empty } = await callTool("get_mod_file", { mod_id: FAKE_MOD_ID, file_id: 1 }, [
      { match: /\/v1\/games/, method: "GET", body: { data: [{ id: 1, slug: "ark-survival-ascended" }], pagination: pagination(1, 1) } },
      { match: /files\/\d+$/, method: "GET", body: { data: { id: 1, modId: 2, dependencies: [] } } },
    ]);
    assert.deepEqual((empty["file"] as Record<string, unknown>)["dependencies"], []);
  });
});

// ---------------------------------------------------------------------------
// search_mods
// ---------------------------------------------------------------------------

describe("search_mods", () => {
  test("gameId comes from the resolver and is sent — it is not a parameter", async () => {
    const { result, calls } = await callTool("search_mods", { search_filter: "structures" });
    const searchCall = calls.find((call) => call.url.includes("/v1/mods/search"));
    assert.ok(searchCall);
    assert.match(searchCall.url, new RegExp(`gameId=${FAKE_GAME_ID}`));
    assert.match(searchCall.url, /searchFilter=structures/);
    const echo = result["query_echo"] as Record<string, unknown>;
    assert.equal(echo["game_id"], FAKE_GAME_ID);
    assert.equal(echo["game_resolved_by"], "candidate-slug");
  });

  test("the tool exposes NO classId or categoryId parameter (§1.7, open question 3)", async () => {
    const { tool } = await callTool("search_mods", {});
    const params = Object.keys(tool.inputSchema);
    assert.equal(params.includes("class_id"), false);
    assert.equal(params.includes("category_id"), false);
    assert.equal(params.includes("game_id"), false, "gameId is resolved, never passed");
    assert.ok(params.includes("search_filter"), "preimage: the schema is not simply empty");
  });

  test("an empty result echoes the query so 'none matched' is legible as an ANSWER", async () => {
    const { result } = await callTool("search_mods", { search_filter: "nothing-matches-this" }, [
      { match: /\/v1\/games/, method: "GET", body: { data: [{ id: FAKE_GAME_ID, slug: "ark-survival-ascended" }], pagination: pagination(1, 1) } },
      { match: /\/v1\/mods\/search/, method: "GET", body: { data: [], pagination: pagination(0, 0) } },
    ]);
    assert.equal(result["result_count_on_this_page"], 0);
    assert.deepEqual(result["mods"], []);
    assert.match(String((result["query_echo"] as Record<string, unknown>)["searchFilter"]), /nothing-matches-this/);
  });

  test("an unresolvable game makes the tool fail loudly rather than search a guessed id", async () => {
    const error = await callTool("search_mods", {}, [
      { match: /\/v1\/games/, method: "GET", body: { data: [{ id: 5, slug: "not-ark" }], pagination: pagination(1, 1) } },
    ]).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "GAME_UNRESOLVED");
  });

  test("the page block states completeness explicitly", async () => {
    const { result } = await callTool("search_mods", {}, [
      { match: /\/v1\/games/, method: "GET", body: { data: [{ id: FAKE_GAME_ID, slug: "ark-survival-ascended" }], pagination: pagination(1, 1) } },
      {
        match: /\/v1\/mods\/search/,
        method: "GET",
        body: { data: [modRecord()], pagination: { index: 0, pageSize: 50, resultCount: 50, totalCount: 900 } },
      },
    ]);
    assert.equal(result["more_results_exist"], true);
    assert.match(String(result["completeness_note"]), /More results exist/);
  });
});

// ---------------------------------------------------------------------------
// get_latest_file — the unresolved product decision, parameterized
// ---------------------------------------------------------------------------

describe("get_latest_file — 'latest' is a REQUIRED, stated choice", () => {
  const older = fileRecord({ id: FAKE_OLDER_FILE_ID, fileDate: "2026-01-01T00:00:00Z" });
  const newerAlt = fileRecord({
    id: 555_002,
    fileDate: "2026-08-15T00:00:00Z",
    releaseType: FAKE_OTHER_RELEASE_TYPE,
    gameVersions: ["8.0.0-other"],
  });
  const threeFileRoutes = (): StubRoute[] => [
    { match: /\/v1\/games/, method: "GET", body: { data: [{ id: FAKE_GAME_ID, slug: "ark-survival-ascended" }], pagination: pagination(1, 1) } },
    {
      match: /\/v1\/mods\/\d+$/,
      method: "GET",
      body: { data: modRecord({ latestFiles: [older, fileRecord(), newerAlt] }) },
    },
    {
      match: /\/v1\/mods\/\d+\/files/,
      method: "GET",
      body: { data: [older, fileRecord(), newerAlt], pagination: pagination(3, 3) },
    },
  ];

  test("selection is a required parameter with no default", async () => {
    const { tool } = await callTool("get_mod", { mod_id: FAKE_MOD_ID });
    void tool;
    const { ctx } = makeContext(threeFileRoutes());
    const latest = allTools(ctx).find((candidate) => candidate.name === "get_latest_file");
    assert.ok(latest);
    assert.ok(Object.keys(latest.inputSchema).includes("selection"));
    // Zod is the enforcement path in the MCP server; assert the schema itself
    // rejects an absent value rather than trusting the description.
    const schema = latest.inputSchema["selection"] as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };
    assert.equal(schema.safeParse(undefined).success, false, "no default: the caller must state which question");
    assert.equal(schema.safeParse("newest_by_file_date").success, true);
    assert.equal(schema.safeParse("newest").success, false);
  });

  test("the three selections give DIFFERENT answers over the same three files", async () => {
    const byDate = await callTool("get_latest_file", { mod_id: FAKE_MOD_ID, selection: "newest_by_file_date" }, threeFileRoutes());
    assert.equal((byDate.result["latest_file"] as Record<string, unknown>)["id"], 555_002);

    const byVersion = await callTool(
      "get_latest_file",
      { mod_id: FAKE_MOD_ID, selection: "newest_matching_game_version", game_version: FAKE_GAME_VERSION },
      threeFileRoutes(),
    );
    assert.equal(
      (byVersion.result["latest_file"] as Record<string, unknown>)["id"],
      FAKE_FILE_ID,
      "the newest file overall does not declare this version, so the version-filtered answer differs",
    );

    const byRelease = await callTool(
      "get_latest_file",
      { mod_id: FAKE_MOD_ID, selection: "newest_with_release_type", release_type: FAKE_RELEASE_TYPE },
      threeFileRoutes(),
    );
    assert.equal((byRelease.result["latest_file"] as Record<string, unknown>)["id"], FAKE_FILE_ID);

    // The whole point of the required parameter: these are three answers, and a
    // server that picked one silently would have been right at most once.
    assert.notEqual(
      (byDate.result["latest_file"] as Record<string, unknown>)["id"],
      (byVersion.result["latest_file"] as Record<string, unknown>)["id"],
    );
  });

  test("every answer restates the ordering, the filter, and how many candidates were considered", async () => {
    const { result } = await callTool(
      "get_latest_file",
      { mod_id: FAKE_MOD_ID, selection: "newest_by_file_date" },
      threeFileRoutes(),
    );
    assert.equal(result["selection"], "newest_by_file_date");
    assert.equal(result["ordering_field"], "fileDate");
    assert.equal(result["candidates_before_filter"], 3);
    assert.equal(result["candidates_after_filter"], 3);
    assert.equal(result["candidate_source"], "mod_record_latest_files");
    assert.match(String(result["filter_applied"]), /ordered by fileDate/);
  });

  test("the version selection without game_version is refused, not defaulted", async () => {
    const error = await callTool(
      "get_latest_file",
      { mod_id: FAKE_MOD_ID, selection: "newest_matching_game_version" },
      threeFileRoutes(),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "ARGUMENT_REFUSED");
    assert.match(error.message, /would answer a different question/);
  });

  test("the release-type selection without release_type is refused, and says why there is no default", async () => {
    const error = await callTool(
      "get_latest_file",
      { mod_id: FAKE_MOD_ID, selection: "newest_with_release_type" },
      threeFileRoutes(),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.match(error.message, /does not assume that 1 means 'release'/);
    assert.match(error.message, /U7/);
  });

  test("no matching file is an ANSWER, not an error", async () => {
    const { result } = await callTool(
      "get_latest_file",
      { mod_id: FAKE_MOD_ID, selection: "newest_with_release_type", release_type: 99_999 },
      threeFileRoutes(),
    );
    assert.equal(result["latest_file"], null);
    assert.equal(result["answer"], "no_matching_file");
    assert.match(String(result["answer_note"]), /This is an answer, not an error/);
  });

  test("it falls back to the files endpoint when the mod record carries no usable candidate", async () => {
    const { result, calls } = await callTool(
      "get_latest_file",
      { mod_id: FAKE_MOD_ID, selection: "newest_by_file_date" },
      [
        { match: /\/v1\/games/, method: "GET", body: { data: [{ id: FAKE_GAME_ID, slug: "ark-survival-ascended" }], pagination: pagination(1, 1) } },
        { match: /\/v1\/mods\/\d+$/, method: "GET", body: { data: modRecord({ latestFiles: [] }) } },
        {
          match: /\/v1\/mods\/\d+\/files/,
          method: "GET",
          body: { data: [fileRecord()], pagination: pagination(1, 1) },
        },
      ],
    );
    assert.equal(result["candidate_source"], "mod_files_endpoint");
    assert.equal((result["latest_file"] as Record<string, unknown>)["id"], FAKE_FILE_ID);
    assert.ok(calls.some((call) => /\/files/.test(call.url)), "E4 must actually have been reached");
  });

  test("candidates with no parseable fileDate cannot be ordered, so it REFUSES rather than picking one", async () => {
    const error = await callTool(
      "get_latest_file",
      { mod_id: FAKE_MOD_ID, selection: "newest_by_file_date" },
      [
        { match: /\/v1\/games/, method: "GET", body: { data: [{ id: FAKE_GAME_ID, slug: "ark-survival-ascended" }], pagination: pagination(1, 1) } },
        {
          match: /\/v1\/mods\/\d+$/,
          method: "GET",
          body: { data: modRecord({ latestFiles: [{ id: 1, modId: 2 }] }) },
        },
        { match: /\/v1\/mods\/\d+\/files/, method: "GET", body: { data: [{ id: 1, modId: 2 }], pagination: pagination(1, 1) } },
      ],
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "UPSTREAM_SHAPE");
    assert.match(error.message, /fabricated answer/);
    assert.equal(error.detail["unverified_row"], "U4");
  });

  test("it never claims to know what the caller's server is running", async () => {
    const { result } = await callTool(
      "get_latest_file",
      { mod_id: FAKE_MOD_ID, selection: "newest_by_file_date" },
      threeFileRoutes(),
    );
    assert.match(String(result["comparison_hint"]), /does NOT know what your server is running/);
    assert.match(String(result["comparison_hint"]), /must not ask Nitrado/);
  });
});

// ---------------------------------------------------------------------------
// resolve_mod_dependencies — one POST per level
// ---------------------------------------------------------------------------

/**
 * A fetch that answers POST /v1/mods from a per-id table, so a BFS can actually
 * walk. Records each POST's parsed id list, which is what makes "one POST per
 * level" a checkable claim rather than a design intention.
 */
function graphFetch(graph: Record<number, number[]>): { fetchImpl: FetchLike; posts: number[][] } {
  const posts: number[][] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (/\/v1\/games/.test(url)) {
      return jsonResponse({ data: [{ id: FAKE_GAME_ID, slug: "ark-survival-ascended" }], pagination: pagination(1, 1) });
    }
    if (/\/v1\/mods\/files$/.test(url)) {
      const ids = (JSON.parse(String(init?.body ?? "{}"))["fileIds"] ?? []) as number[];
      return jsonResponse({
        data: ids.map((id) => ({ id, modId: FAKE_MOD_ID, dependencies: [] })),
      });
    }
    if (/\/v1\/mods$/.test(url)) {
      const ids = (JSON.parse(String(init?.body ?? "{}"))["modIds"] ?? []) as number[];
      posts.push(ids);
      return jsonResponse({
        data: ids.map((id) => ({
          id,
          name: `Synthetic mod ${id}`,
          slug: `synthetic-${id}`,
          latestFiles: [
            {
              id: id + 1_000,
              modId: id,
              fileDate: "2026-08-01T00:00:00Z",
              dependencies: (graph[id] ?? []).map((dep) => ({ modId: dep, relationType: FAKE_RELATION_TYPE })),
            },
          ],
        })),
      });
    }
    return jsonResponse({ error: `unrouted ${url}` }, 404);
  };
  return { fetchImpl, posts };
}

async function resolveGraph(graph: Record<number, number[]>, args: Record<string, unknown>) {
  const config = testConfig();
  const { fetchImpl, posts } = graphFetch(graph);
  const client = new CurseForgeClient(config, fetchImpl);
  const games = createGameResolver(client, { configuredSlug: null });
  const tool = allTools({ client, config, games }).find((candidate) => candidate.name === "resolve_mod_dependencies");
  assert.ok(tool);
  return { result: (await tool.handler(args)) as Record<string, unknown>, posts };
}

describe("resolve_mod_dependencies — one POST per LEVEL, not one GET per node", () => {
  test("a three-level chain costs three POSTs, one per level", async () => {
    const { result, posts } = await resolveGraph(
      { [FAKE_MOD_ID]: [FAKE_DEP_MOD_ID], [FAKE_DEP_MOD_ID]: [FAKE_DEEP_MOD_ID], [FAKE_DEEP_MOD_ID]: [] },
      { mod_ids: [FAKE_MOD_ID] },
    );
    assert.deepEqual(posts, [[FAKE_MOD_ID], [FAKE_DEP_MOD_ID], [FAKE_DEEP_MOD_ID]]);
    const traversal = result["traversal"] as Record<string, unknown>;
    assert.equal(traversal["nodes_resolved"], 3);
    assert.equal(traversal["request_count"], 3, "three levels, three requests — NOT three-plus per node");
  });

  test("a WIDE level is still ONE request — this is the efficiency a method check would have destroyed", async () => {
    const children = [201, 202, 203, 204, 205];
    const graph: Record<number, number[]> = { [FAKE_MOD_ID]: children };
    for (const child of children) graph[child] = [];
    const { posts } = await resolveGraph(graph, { mod_ids: [FAKE_MOD_ID] });
    assert.equal(posts.length, 2, "seed level plus one level of five children");
    assert.deepEqual(posts[1], children, "all five fetched in a single POST body");
  });

  test("a CYCLE terminates via the visited set", async () => {
    const { result, posts } = await resolveGraph(
      { [FAKE_MOD_ID]: [FAKE_DEP_MOD_ID], [FAKE_DEP_MOD_ID]: [FAKE_MOD_ID] },
      { mod_ids: [FAKE_MOD_ID] },
    );
    assert.ok(posts.length <= MAX_DEPTH + 1, `a cycle must not loop: ${posts.length} requests`);
    assert.equal((result["traversal"] as Record<string, unknown>)["nodes_resolved"], 2);
  });

  test("hitting the depth cap reports TRUNCATED with the unexplored frontier listed", async () => {
    // A chain longer than the requested depth.
    const graph: Record<number, number[]> = {};
    for (let id = 1; id <= 10; id += 1) graph[id] = [id + 1];
    const { result } = await resolveGraph(graph, { mod_ids: [1], max_depth: 2 });
    const traversal = result["traversal"] as Record<string, unknown>;
    assert.equal(traversal["truncated"], true);
    assert.equal(traversal["truncated_by"], "depth");
    assert.match(String(traversal["truncation_note"]), /TRUNCATED/);
    assert.match(String(traversal["truncation_note"]), /PREFIX of the real one/);
    assert.deepEqual(traversal["unexplored_frontier"], [3], "the frontier must be named, not silently dropped");
  });

  test("PREIMAGE: a tree that fits is NOT reported as truncated", async () => {
    const { result } = await resolveGraph({ [FAKE_MOD_ID]: [] }, { mod_ids: [FAKE_MOD_ID] });
    const traversal = result["traversal"] as Record<string, unknown>;
    assert.equal(traversal["truncated"], false);
    assert.equal(traversal["truncation_note"], null);
  });

  test("it says out loud that it over-collects, because relationType cannot be filtered (U6)", async () => {
    const { result } = await resolveGraph(
      { [FAKE_MOD_ID]: [FAKE_DEP_MOD_ID], [FAKE_DEP_MOD_ID]: [] },
      { mod_ids: [FAKE_MOD_ID] },
    );
    assert.match(String(result["over_collection_warning"]), /OVER-COLLECT|Do NOT read it as a list of requirements/);
    assert.match(String(result["relation_type_note"]), /U6/);
    const nodes = result["nodes"] as Array<Record<string, unknown>>;
    const edges = nodes[0]?.["edges"] as Array<Record<string, unknown>>;
    assert.equal(edges[0]?.["relation_type_raw"], FAKE_RELATION_TYPE, "the raw integer, unmapped");
    assert.equal("relation_type" in (edges[0] ?? {}), false, "no mapped label anywhere");
  });

  test("file-id seeds go through E7 first, then the walk continues on E6", async () => {
    const { result, posts } = await resolveGraph({ [FAKE_MOD_ID]: [] }, { file_ids: [FAKE_FILE_ID] });
    assert.equal((result["seed"] as Record<string, unknown>)["seed_files_resolved"], 1);
    const requests = (result["traversal"] as Record<string, unknown>)["requests_issued"] as Array<
      Record<string, unknown>
    >;
    assert.equal(requests[0]?.["endpoint"], "E7");
    assert.ok(
      requests.slice(1).every((request) => request["endpoint"] === "E6"),
      "the walk itself is E6",
    );
    assert.ok(posts.length >= 1);
  });

  test("an empty seed is refused rather than answered with an empty tree", async () => {
    const error = await resolveGraph({}, {}).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "ARGUMENT_REFUSED");
  });

  test("seed ids CurseForge did not return are reported rather than dropped", async () => {
    // 999 is in the seed but the graph fetch returns records only for ids it is
    // asked for — so give the seed an id the stub answers for, and one it does not.
    const { result } = await resolveGraph({ [FAKE_MOD_ID]: [] }, { mod_ids: [FAKE_MOD_ID] });
    assert.deepEqual(result["seed_ids_not_returned_by_curseforge"], []);
    assert.ok("seed_ids_not_returned_by_curseforge" in result, "the field must exist even when empty");
  });

  test("the node cap is a named constant, not a magic number in a loop", () => {
    assert.equal(typeof MAX_NODES, "number");
    assert.equal(typeof MAX_DEPTH, "number");
  });
});

// ---------------------------------------------------------------------------
// get_api_diagnostics
// ---------------------------------------------------------------------------

describe("get_api_diagnostics — the honest-status tool", () => {
  test("it reports a PARTIALLY verified posture — neither 'verified' nor 'nothing checked'", async () => {
    const { result } = await callTool("get_api_diagnostics");
    const posture = result["version_posture"] as Record<string, unknown>;
    assert.match(String(posture["stage"]), /PARTIALLY verified/);
    assert.equal(posture["first_live_verification"], "2026-08-18");
    // A boolean would be a lie in both directions now, so it must not be one.
    assert.notEqual(posture["field_paths_verified"], true);
    assert.notEqual(posture["field_paths_verified"], false);
    assert.deepEqual(posture["unresolved_rows"], ["U5", "U6", "U7", "U10"]);
    assert.equal(
      JSON.stringify(result).includes("No authenticated CurseForge call has ever been made"),
      false,
      "that claim became false on 2026-08-18 and must not survive anywhere in tool output",
    );
  });

  test("it never reports the key, a prefix of it, or its LENGTH", async () => {
    const { result } = await callTool("get_api_diagnostics");
    const credential = result["credential"] as Record<string, unknown>;
    assert.equal(credential["configured"], true);
    assert.equal(credential["header"], "x-api-key");
    const rendered = JSON.stringify(result);
    assert.equal(rendered.includes("SYNTHETIC-cf-key"), false, "not the key");
    assert.equal(rendered.includes("SYNTHETIC-cf"), false, "not a prefix either");
    for (const key of Object.keys(credential)) {
      assert.equal(/length/i.test(key), false, "a length is a real hint and buys the reader nothing");
    }
  });

  test("it reports the build stamp and the allow-list it is actually running", async () => {
    const { result } = await callTool("get_api_diagnostics");
    const build = result["build"] as Record<string, unknown>;
    assert.ok("commit" in build && "dirty" in build);
    const transport = result["transport"] as Record<string, unknown>;
    assert.equal(transport["allowlist_size"], 7);
    // The first live run printed "E1 GET GET /v1/games" — the method twice.
    for (const entry of transport["allowlist"] as string[]) {
      assert.equal(/(GET|POST).*(GET|POST)/.test(entry), false, `method printed twice: ${entry}`);
    }
    assert.deepEqual(transport["post_capable_tools"], ["resolve_mod_dependencies"]);
    assert.match(JSON.stringify(transport["refused_by_design"]), /download-url/);
    assert.match(JSON.stringify(transport["refused_by_design"]), /Nitrado/);
  });

  test("it reports the resolved gameId and HOW it resolved", async () => {
    const { result } = await callTool("get_api_diagnostics");
    const game = result["game_resolution"] as Record<string, unknown>;
    assert.equal(game["resolved"], true);
    assert.equal(game["game_id"], FAKE_GAME_ID);
    assert.equal(game["matched_by"], "candidate-slug");
  });

  test("an unresolved gameId is reported as a failure WITHOUT throwing — diagnostics must still answer", async () => {
    const { result } = await callTool("get_api_diagnostics", {}, [
      { match: /\/v1\/games/, method: "GET", body: { data: [{ id: 9, slug: "not-ark" }], pagination: pagination(1, 1) } },
    ]);
    const game = result["game_resolution"] as Record<string, unknown>;
    assert.equal(game["resolved"], false);
    assert.match(String(game["error"]), /could not be found/);
    assert.match(String(game["note"]), /NEVER hardcoded or guessed/);
  });

  test("rate limits are null when nothing was observed, with 'absent is not zero' said out loud", async () => {
    const { result } = await callTool("get_api_diagnostics");
    const rate = result["rate_limit"] as Record<string, unknown>;
    assert.equal(rate["observed"], null);
    assert.match(String(rate["note"]), /Absent is not zero/);
    assert.match(String(rate["note"]), /NOT a claim that there is no/);
    // The live measurement is recorded, and it still does not become "no limit".
    assert.match(String(rate["measured_2026_08_18"]), /NO rate-limit header of any name/);
    assert.match(String(rate["measured_2026_08_18"]), /NOT a claim that\s+no limit exists/);
  });
});

// ---------------------------------------------------------------------------
// DEC-002 §11.3 — no download URL, and the endpoint exclusion is not enough
// ---------------------------------------------------------------------------

describe("§11.3 — a download URL must never reach a tool result", () => {
  /**
   * Discovered live 2026-08-18: a real File record carries a populated
   * `downloadUrl`. Keeping the download-url ENDPOINT off the allow-list (§1.7)
   * therefore does NOT deliver "no download or install" on its own — the URL
   * arrives inside records fetched from endpoints that ARE allowed, and the
   * shapers dropping it is the other half of the control.
   *
   * Preimage first, per the house rule: the fixture must actually contain the URL,
   * or the assertion that it was dropped passes against nothing.
   */
  test("PREIMAGE: the File fixture DOES carry a populated downloadUrl", () => {
    const fixture = fileRecord() as Record<string, unknown>;
    assert.equal(typeof fixture["downloadUrl"], "string");
    assert.match(String(fixture["downloadUrl"]), new RegExp(FAKE_DOWNLOAD_URL_MARKER));
  });

  test("get_mod_file does not surface it", async () => {
    const { result } = await callTool("get_mod_file", { mod_id: FAKE_MOD_ID, file_id: FAKE_FILE_ID });
    const rendered = JSON.stringify(result);
    assert.equal(rendered.includes(FAKE_DOWNLOAD_URL_MARKER), false);
    assert.equal(/download_url"\s*:/.test(rendered), false, "and no renamed passthrough either");
  });

  test("list_mod_files does not surface it", async () => {
    const { result } = await callTool("list_mod_files", { mod_id: FAKE_MOD_ID });
    assert.equal(JSON.stringify(result).includes(FAKE_DOWNLOAD_URL_MARKER), false);
  });

  test("search_mods does not surface it through the nested latestFiles", async () => {
    const { result } = await callTool("search_mods", {});
    assert.equal(JSON.stringify(result).includes(FAKE_DOWNLOAD_URL_MARKER), false);
  });

  test("get_latest_file does not surface it", async () => {
    const { result } = await callTool("get_latest_file", {
      mod_id: FAKE_MOD_ID,
      selection: "newest_by_file_date",
    });
    assert.equal(JSON.stringify(result).includes(FAKE_DOWNLOAD_URL_MARKER), false);
  });
});

// ---------------------------------------------------------------------------
// Live findings that deserve a standing test
// ---------------------------------------------------------------------------

describe("2026-08-18 live findings, pinned", () => {
  test("the ASA gameId is recorded in prose but NEVER hardcoded as code", () => {
    // Knowing the value is not permission to stop resolving it (§5): a wrong
    // hardcoded id returns a clean, empty, entirely wrong result set, and that
    // failure is exactly as silent now that someone has written the number down.
    //
    // Comments are stripped first, so the control is "no executable literal"
    // rather than "the number is unmentionable in prose" — recording an
    // observation in a docstring is the opposite of burying an assumption in code.
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

    let sawItInProse = false;
    for (const text of srcFiles()) {
      if (/\b83374\b/.test(text)) sawItInProse = true;
      assert.equal(
        /\b83374\b/.test(stripComments(text)),
        false,
        "the gameId must never appear outside a comment in src/",
      );
    }
    assert.ok(sawItInProse, "preimage: the stripper must be running over text that DOES contain the number");
  });

  test("resolve_mod_dependencies reports the empty-tree finding rather than looking broken", async () => {
    const { result } = await callTool("resolve_mod_dependencies", { mod_ids: [FAKE_MOD_ID] });
    assert.match(String(result["asa_catalog_observation"]), /ZERO/);
    assert.match(String(result["asa_catalog_observation"]), /1899 file records/);
    assert.match(
      String(result["asa_catalog_observation"]),
      /not 'the traversal broke'/,
      "an empty tree for ASA is the expected answer and must read as one",
    );
  });

  test("the releaseType note records the observed integers WITHOUT mapping them", async () => {
    const { result } = await callTool("get_mod_file", { mod_id: FAKE_MOD_ID, file_id: FAKE_FILE_ID });
    const note = String((result["file"] as Record<string, unknown>)["release_type_note"]);
    assert.match(note, /1 \(1893 files\), 2 \(3\) and 3 \(3\)/, "the distribution is evidence for whoever resolves U7");
    assert.match(note, /a frequency distribution is not a value table/);
    assert.match(note, /NOT mapped/);
  });
});

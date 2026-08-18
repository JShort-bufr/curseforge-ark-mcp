#!/usr/bin/env node
/**
 * `npm run smoke` — the one command that turns key-arrival into a task rather
 * than a research project (ADR-002 §13.4, §13.5).
 *
 * TWO MODES, and the first one is the one that runs today:
 *
 *  1. NO KEY. It refuses CLEANLY — naming every probe it would have made and
 *     which row of ADR-002 §14.3 each probe would falsify — and exits 0. Exit 0
 *     because "no key yet" is the documented, expected state of this repo, not a
 *     failure of it; the banner says NOT RUN in those words so nobody reads a
 *     green exit code as a passing verification.
 *
 *  2. KEY PRESENT. It runs the probes in dependency order and prints, per §14.3
 *     row, what was actually observed. ITS OUTPUT IS THE INPUT TO AN AMENDMENT:
 *     amend ADR-002 in place, dated and attributed (§13.5), rather than leaving a
 *     reader to reconcile two versions.
 *
 * Nothing here writes state, schedules anything, or persists a "last seen
 * version" — §10 forbids all three.
 */
import { CurseForgeClient } from "./client.js";
import { bootstrapEnv, loadConfig } from "./config.js";
import { CurseForgeError } from "./errors.js";
import { createGameResolver } from "./game.js";
import { PROBE_PLAN } from "./probe-plan.js";
import { allTools } from "./tools/index.js";

const NO_KEY_BANNER = [
  "",
  "  ============================================================",
  "   SMOKE NOT RUN — no CurseForge API key is configured.",
  "  ============================================================",
  "",
  "  This is the EXPECTED state of this repo, not a failure of it.",
  "  Nothing was probed, nothing was sent, and no network call was made.",
  "",
  "  To run it:",
  "    1. Apply to Overwolf for a CurseForge API key. It is NOT self-service —",
  "       there is no dashboard button, and a key is non-transferable, so you",
  "       cannot borrow one.",
  "    2. Copy .env.example to .env and set CURSEFORGE_API_KEY (or put it in your",
  "       MCP client's env block, which takes precedence).",
  "    3. Run `npm run smoke` again.",
  "",
  "  What it will probe when it can, and which unverified claim each probe",
  "  settles (ADR-002 §14.3):",
  "",
].join("\n");

function renderPlan(): string {
  return PROBE_PLAN.map((step) => `    ${step.row.padEnd(4)} ${step.claim}\n         probe: ${step.probe}`).join("\n");
}

/**
 * Refuse to print anything containing the credential.
 *
 * No tool echoes the key and none should. But this script is the one place raw
 * tool output reaches a terminal and, from there, a transcript or a screenshot —
 * so it re-checks rather than trusting. A leak caught here is a bug report; a
 * leak printed here is a revoked key, and this key cannot be regenerated on
 * demand.
 */
function assertNoSecrets(label: string, payload: unknown, key: string): string {
  const text = JSON.stringify(payload, null, 2);
  if (key.length >= 8 && text.includes(key)) {
    throw new Error(
      `${label} output contained the API key and was NOT printed. This is a redaction bug — report it before ` +
        `rerunning, and note that this key must be re-APPLIED for rather than regenerated.`,
    );
  }
  return text;
}

async function main(): Promise<void> {
  const envSources = bootstrapEnv();

  // Deliberately NOT loadConfig() inside a bare try/catch that prints a stack.
  // The no-key case is the common case today and it gets a written answer, not a
  // trace. Any OTHER config problem still throws and is reported by code.
  const rawKey = process.env["CURSEFORGE_API_KEY"];
  if (rawKey === undefined || rawKey.trim() === "") {
    console.log(NO_KEY_BANNER + renderPlan());
    console.log(
      "\n  Searched for a key in: process.env, and " +
        (envSources.envFilePath === null
          ? "no .env was found beside the server code."
          : `${envSources.envFilePath}.`) +
        "\n",
    );
    // Exit 0: the refusal is the correct outcome of running this today, and the
    // banner above is unmissable. If you want this to fail a pipeline, gate the
    // pipeline on the key's presence rather than on this exit code.
    process.exit(0);
  }

  const config = loadConfig(process.env, envSources);
  const client = new CurseForgeClient(config);
  const games = createGameResolver(client, { configuredSlug: config.gameSlug });
  const tools = allTools({ client, config, games });

  const run = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool ${name} is not registered`);
    return tool.handler(args);
  };

  console.log("curseforge-ark-mcp smoke — v0, probing to FALSIFY ADR-002 §14.3 row by row.");
  console.log("key loaded: yes (value never printed, and its length is never printed either)\n");

  // 1. Diagnostics first: it distinguishes "bad key" from "CurseForge down" from
  //    "ASA not visible to this key", which are the three things most likely to
  //    be wrong on a first run and which need very different responses.
  console.log("── get_api_diagnostics (U1, U2, U11, U13) ──");
  const diagnostics = (await run("get_api_diagnostics")) as Record<string, unknown>;
  console.log(assertNoSecrets("get_api_diagnostics", diagnostics, config.apiKey));

  const resolution = diagnostics["game_resolution"] as Record<string, unknown> | undefined;
  if (resolution?.["resolved"] !== true) {
    console.error(
      "\nThe ARK: Survival Ascended gameId did not resolve, so no further probe can run. Two possibilities " +
        "with different answers: the slug candidates are wrong (U1 — set CURSEFORGE_GAME_SLUG), or ASA is not " +
        "visible to this key at all (U2 — a v1-blocking discovery that belongs back at the board, not worked " +
        "around in code).",
    );
    process.exit(1);
  }

  // 2. Search. First contact with the Mod shape, and the first chance for a field
  //    path to be wrong (U3, U8, U12).
  console.log("\n── search_mods (U3, U8, U12) ──");
  const search = (await run("search_mods", { page_size: 10, index: 0 })) as Record<string, unknown>;
  console.log(assertNoSecrets("search_mods", search, config.apiKey));

  const mods = (search["mods"] as Array<Record<string, unknown>> | undefined) ?? [];
  if (mods.length === 0) {
    console.error(
      "\nThe search returned zero mods. That is a REAL ANSWER from the API and not an error — but at page 1 " +
        "of an unfiltered ASA search it is a suspicious one, and the first thing to suspect is a wrong gameId " +
        "(U1) rather than an empty catalog.",
    );
    process.exit(1);
  }

  const firstId = mods[0]?.["id"];
  if (typeof firstId !== "number") {
    console.error(
      "\nThe first mod record carried no numeric `id`, which means the Mod field paths this client reads are " +
        "WRONG (U3). This is the exact failure the sibling repo's commit 5481c04 fixed. Correct the paths in " +
        "src/tools/context.ts and amend ADR-002 §14.3 in place, dated and attributed.",
    );
    process.exit(1);
  }

  // 3. Files. The File shape, its dependency edges, and the two unmapped enums
  //    (U4, U5, U6, U7, U9).
  console.log(`\n── list_mod_files on mod ${firstId} (U4, U5, U6, U7, U9) ──`);
  const files = (await run("list_mod_files", { mod_id: firstId, page_size: 10 })) as Record<string, unknown>;
  console.log(assertNoSecrets("list_mod_files", files, config.apiKey));

  // 4. The batch reads, which is where U10 gets probed and where §8's "one POST
  //    per level" claim meets a real API.
  console.log(`\n── resolve_mod_dependencies on mod ${firstId} (U5, U6, U10) ──`);
  const tree = (await run("resolve_mod_dependencies", { mod_ids: [firstId], max_depth: 2 })) as Record<
    string,
    unknown
  >;
  console.log(assertNoSecrets("resolve_mod_dependencies", tree, config.apiKey));

  console.log(
    "\nSmoke completed. NOTHING IS 'VERIFIED' UNTIL A HUMAN READS THE ABOVE AGAINST ADR-002 §14.3 AND AMENDS " +
      "IT. Rows U6 and U7 in particular cannot be settled by observation alone: this run can enumerate the " +
      "integers it saw, and no number of observations makes an unpublished enum table known.",
  );
}

main().catch((error: unknown) => {
  if (error instanceof CurseForgeError) {
    console.error(`smoke failed — ${error.code}: ${error.message}`);
  } else {
    console.error(`smoke failed — ${String(error)}`);
  }
  process.exit(1);
});

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { POST_CAPABLE_TOOLS } from "../src/allowlist.js";
import { CurseForgeError } from "../src/errors.js";
import { assertAllToolsAreReadOnly, type TieredTool } from "../src/registry.js";
import { openRows, PROBE_PLAN } from "../src/probe-plan.js";
import { allTools, V1_TOOL_NAMES } from "../src/tools/index.js";
import { makeContext, repoRoot, standardRoutes } from "./fixtures.js";

/** ADR-002 §7, §8, §11 — the surface, and the assertion that keeps it read-only. */

describe("§7 — the tool surface, all tier 1", () => {
  test("the surface is the Amendment-5 names, in that set", async () => {
    const { ctx } = makeContext(standardRoutes());
    const tools = allTools(ctx);
    assert.equal(tools.length, V1_TOOL_NAMES.length);
    assert.deepEqual([...tools.map((tool) => tool.name)].sort(), [...V1_TOOL_NAMES].sort());
    assert.ok(V1_TOOL_NAMES.includes("list_categories"));
  });

  test("every tool declares tier 1", () => {
    const { ctx } = makeContext(standardRoutes());
    for (const tool of allTools(ctx)) assert.equal(tool.tier, 1, `${tool.name} must be tier 1`);
  });

  test("every tool has a non-empty description that says it is read-only or v0", () => {
    const { ctx } = makeContext(standardRoutes());
    for (const tool of allTools(ctx)) {
      assert.ok(tool.description.length > 80, `${tool.name} needs a description a model can act on`);
      assert.match(
        tool.description,
        /Read-only|read-only|unverified/,
        `${tool.name} must state its posture where the model will actually read it`,
      );
    }
  });
});

describe("§11 — THE BOOT ASSERTION: a mutating tool is a process that will not start", () => {
  test("PREIMAGE: the real tools pass", () => {
    const { ctx } = makeContext(standardRoutes());
    assert.doesNotThrow(() => assertAllToolsAreReadOnly(allTools(ctx)));
  });

  test("a deliberately-registered tier-2 tool REFUSES TO START", () => {
    const tools: TieredTool[] = [
      { name: "get_mod", tier: 1 },
      { name: "publish_mod_file", tier: 2 },
      { name: "resolve_mod_dependencies", tier: 1 },
    ];
    const error = (() => {
      try {
        assertAllToolsAreReadOnly(tools);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "CONFIG");
    assert.match(error.message, /publish_mod_file/);
    assert.match(error.message, /refused at startup/);
  });

  test("a tier-3 tool refuses too", () => {
    assert.throws(
      () => assertAllToolsAreReadOnly([{ name: "delete_project", tier: 3 }, { name: "resolve_mod_dependencies", tier: 1 }]),
      /delete_project/,
    );
  });

  test("the assertion reads NO environment variable — two controls that fail for the same reason are one control", () => {
    // Structural rather than behavioural, and deliberately so: the property is
    // "cannot be defeated by a wrong variable", and the only way to check that a
    // function consults no variable is to look at what it can reach.
    const source = readFileSync(join(repoRoot(), "src", "registry.ts"), "utf8");
    const assertionBody = source.slice(
      source.indexOf("export function assertAllToolsAreReadOnly"),
      source.indexOf("export interface RegistrationReport"),
    );
    assert.ok(assertionBody.length > 200, "preimage: the slice found the function body");
    assert.equal(assertionBody.includes("process.env"), false);
    assert.equal(assertionBody.includes("config"), false, "it must not take a Config either");
  });

  test("POST_CAPABLE_TOOLS naming a tool that does not exist refuses to start", () => {
    assert.throws(
      () => assertAllToolsAreReadOnly([{ name: "get_mod", tier: 1 }], ["a_tool_that_was_renamed"]),
      /guarding a ghost/,
    );
  });

  test("the shipped POST-capable list names a real tool", () => {
    const { ctx } = makeContext(standardRoutes());
    const names = new Set(allTools(ctx).map((tool) => tool.name));
    for (const name of POST_CAPABLE_TOOLS) assert.ok(names.has(name));
  });
});

describe("§9 / §10 — what must not exist anywhere in this repo", () => {
  const sourceFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith(".ts")) out.push(readFileSync(child, "utf8"));
      }
    };
    // The repo root, not a path relative to this compiled module: tests run from
    // dist/test/, where "../src" holds .js and a .ts filter would match nothing.
    walk(join(repoRoot(), "src"));
    return out;
  };

  test("PREIMAGE: the walker actually reads this repo's source", () => {
    const files = sourceFiles();
    assert.ok(files.length >= 10, `expected the src tree, got ${files.length} file(s)`);
    assert.ok(
      files.some((text) => text.includes("ENDPOINT_ALLOWLIST")),
      "the allow-list must be among the files scanned, or the scans below prove nothing",
    );
  });

  test("no NITRADO_ variable is read anywhere — its absence is a control (§9)", () => {
    for (const text of sourceFiles()) {
      // Match a real env read, not this test's own prose about it.
      assert.equal(/env\[["']NITRADO_/.test(text), false);
      assert.equal(/process\.env\.NITRADO_/.test(text), false);
    }
  });

  test("no scheduler, timer loop, or persisted state (§10)", () => {
    for (const text of sourceFiles()) {
      assert.equal(/setInterval\(/.test(text), false, "§10 forbids any timer-driven loop");
      assert.equal(/node:cron|node-cron/.test(text), false);
      // writeFile* would be persisted state. The buildinfo GENERATOR is a build
      // script under scripts/, not src/, so it is correctly out of this scan.
      assert.equal(/writeFileSync|writeFile\(/.test(text), false, "§10 forbids persisted 'last seen version' state");
    }
  });

  test(".env.example carries no NITRADO_ variable and no key value", () => {
    const example = readFileSync(join(repoRoot(), ".env.example"), "utf8");
    assert.match(example, /CURSEFORGE_API_KEY=\s*$/m, "the key line must be present and EMPTY");
    assert.equal(/^NITRADO_/m.test(example), false);
    // The absence should be explained, not merely present, or a future reader
    // adds one "for convenience".
    assert.match(example, /NITRADO_\* variable in this file/i);
  });
});

describe("§13.5 — the smoke probe plan covers every unverified row", () => {
  test("all of U1..U13 appear in PROBE_PLAN", () => {
    const rows = new Set(PROBE_PLAN.map((step) => step.row));
    for (let n = 1; n <= 13; n += 1) {
      assert.ok(rows.has(`U${n}`), `PROBE_PLAN has no probe for U${n}, so §14.3 would go partly unfalsified`);
    }
    assert.equal(rows.size, 13, "and no invented extra rows");
  });

  test("U6 and U7 say plainly that observation alone cannot settle them", () => {
    const u6 = PROBE_PLAN.find((step) => step.row === "U6");
    assert.match(String(u6?.probe), /never label them|cannot/);
  });
});

describe("§13.5 — the probe plan is also a status board (amended 2026-08-18)", () => {
  test("every row carries a status and a finding, and the four known-open rows are marked open", () => {
    for (const step of PROBE_PLAN) {
      assert.ok(step.finding.length > 20, `${step.row} has no finding recorded`);
      assert.ok(step.status === "RESOLVED" || step.status === "STILL OPEN", `${step.row} has no status`);
    }
    assert.deepEqual(
      openRows().map((step) => step.row),
      ["U5", "U6", "U7", "U10"],
      "these are the rows live measurement did not close; changing this set is a documentation act",
    );
  });

  test("the diagnostics tool's open-row list agrees with the probe plan", async () => {
    // Two places state which rows are open. They must not be able to disagree —
    // that is the same class of drift the offering-count gate exists for next door.
    const { ctx } = makeContext(standardRoutes());
    const tool = allTools(ctx).find((candidate) => candidate.name === "get_api_diagnostics");
    assert.ok(tool);
    const result = (await tool.handler({})) as Record<string, unknown>;
    const posture = result["version_posture"] as Record<string, unknown>;
    assert.deepEqual(posture["unresolved_rows"], openRows().map((step) => step.row));
  });

  test("no resolved row claims a value it did not observe", () => {
    // U6 and U7 in particular must not have acquired a mapping by tidying.
    const u6 = PROBE_PLAN.find((step) => step.row === "U6");
    const u7 = PROBE_PLAN.find((step) => step.row === "U7");
    assert.equal(u6?.status, "STILL OPEN");
    assert.equal(u7?.status, "STILL OPEN");
    for (const label of ["release", "beta", "alpha", "required", "optional", "incompatible"]) {
      assert.equal(
        new RegExp(`= *${label}|${label} *=`).test(String(u6?.finding) + String(u7?.finding)),
        false,
        `${label} appears to have been assigned a numeric meaning`,
      );
    }
  });
});

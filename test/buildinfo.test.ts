import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInfo } from "../src/buildinfo.js";
import { describeBuild } from "../src/tools/diagnostics.js";
import { repoRoot } from "./fixtures.js";

/**
 * ADR-002 §13.3 — `buildinfo` is generated, gitignored, and stamped at BUILD time.
 *
 * The sibling repo's reasoning applies unchanged: `dist/` is gitignored and the
 * MCP server runs from it as a long-lived stdio process, so reading git at
 * runtime would answer "what is checked out now", which is a different question
 * from "which code produced that answer".
 */

describe("§13.3 — the build stamp", () => {
  test("the generated module has the shape the diagnostics tool reads", () => {
    assert.equal(typeof buildInfo.commit, "string");
    assert.equal(typeof buildInfo.shortCommit, "string");
    assert.equal(typeof buildInfo.builtAt, "string");
    assert.ok(buildInfo.dirty === null || typeof buildInfo.dirty === "boolean");
    assert.notEqual(buildInfo.commit, "", "empty would read as falsy and get quietly papered over; 'unknown' does not");
  });

  test("a dirty build gets a caveat, and a clean one gets NONE", () => {
    assert.match(String(describeBuild({ ...buildInfo, commit: "abc1234", dirty: true })), /uncommitted or untracked/);
    assert.equal(
      describeBuild({ ...buildInfo, commit: "abc1234", dirty: false }),
      null,
      "an unconditional note trains the reader to skip it, and then the dirty warning goes unread",
    );
  });

  test("dirty null means UNKNOWN, not clean", () => {
    const note = describeBuild({ ...buildInfo, commit: "abc1234", dirty: null });
    assert.match(String(note), /unknown/);
  });

  test("no git at all yields commit 'unknown' and dirty null — a build must not fail for want of git", () => {
    const scratch = mkdtempSync(join(tmpdir(), "cf-buildinfo-"));
    const out = join(scratch, "buildinfo.ts");
    execFileSync(process.execPath, [join(repoRoot(), "scripts", "generate-buildinfo.mjs"), out, scratch], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const generated = readFileSync(out, "utf8");
    assert.match(generated, /commit: "unknown"/);
    assert.match(generated, /dirty: null/);
    assert.match(generated, /DO NOT COMMIT/);
  });
});

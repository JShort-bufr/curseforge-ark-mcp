#!/usr/bin/env node
/**
 * Stamp build provenance into a generated module, at BUILD time.
 *
 * Why a generated file rather than reading git at runtime:
 *
 * `dist/` is gitignored and the MCP server runs from it as a long-lived stdio
 * process. Rebuilding does not hot-reload that process, so the code acting on
 * the game server can be arbitrarily older than the checkout. Reading `.git` at
 * runtime would answer "what is checked out right now", which is a different
 * question and precisely the confusion this exists to remove. Worse, a build
 * copied to a machine with no `.git` (a tarball, a container layer) would have
 * nothing to read at all.
 *
 * So the SHA is frozen into the artifact at the moment tsc runs, and travels
 * with it.
 *
 * `dirty` is the field that earns its keep. A build made from a tree with
 * uncommitted changes is exactly the case where "built from commit abc1234" is
 * a lie, so that must be visible rather than hidden behind a clean-looking SHA.
 *
 * Usage: node scripts/generate-buildinfo.mjs [outFile] [gitDir]
 *   outFile  where to write the module   (default <repo>/src/buildinfo.ts)
 *   gitDir   which tree to interrogate   (default <repo>)
 * Both are overridable so the test suite can exercise the no-git path against a
 * throwaway directory without touching the real build output.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The single string meaning "this build cannot say". Never an empty string:
 * an empty commit reads as a falsy value that callers quietly paper over,
 * whereas "unknown" survives being printed, logged, and compared.
 */
const UNKNOWN = "unknown";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    // Inherit nothing. A git that decides to prompt must fail, not hang a build.
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Gather provenance, degrading to "unknown" rather than throwing.
 *
 * Every failure mode collapses to the same answer on purpose: no git binary on
 * PATH, no repository (a tarball build), or a repository with no commit yet are
 * all "this build cannot name its commit". A build must never fail because the
 * person building it does not have git.
 */
function collect(cwd) {
  const builtAt = new Date().toISOString();

  let commit;
  try {
    commit = git(["rev-parse", "HEAD"], cwd);
  } catch {
    // dirty is null, not false. "I could not check" is not "there was nothing
    // to find" - the same distinction src/coerce.ts draws for absent readings.
    return { commit: UNKNOWN, shortCommit: UNKNOWN, builtAt, dirty: null };
  }

  // Guard against git handing back something that is not an object name. The
  // bound is loose deliberately: sha1 is 40 hex, sha256 repositories are 64,
  // and hardcoding 40 would report "unknown" on a perfectly good sha256 repo.
  if (!/^[0-9a-f]{7,64}$/.test(commit)) {
    return { commit: UNKNOWN, shortCommit: UNKNOWN, builtAt, dirty: null };
  }

  let dirty;
  try {
    // Untracked files count as dirty. An untracked file can be a source file
    // that tsc just compiled into this very artifact, so ignoring it would let
    // the commit claim cover code that is not in the commit. Paths matched by
    // .gitignore (dist/, node_modules/, this generated file) are already
    // excluded by git itself, so routine builds do not self-report dirty.
    dirty = git(["status", "--porcelain"], cwd).length > 0;
  } catch {
    dirty = null;
  }

  return { commit, shortCommit: commit.slice(0, 7), builtAt, dirty };
}

function render(info) {
  return (
    [
      "// GENERATED FILE - DO NOT EDIT, DO NOT COMMIT.",
      "//",
      "// Written by scripts/generate-buildinfo.mjs immediately before every tsc",
      "// run, and gitignored. It records which commit produced the artifact in",
      "// dist/, which is not answerable from git once that artifact is running,",
      "// because dist/ is gitignored and the server process does not reload.",
      "//",
      "// `dirty` is true when the working tree had uncommitted or untracked",
      "// changes at build time, and null when no git was available to ask.",
      "// null is not false: it means unknown.",
      "",
      "export interface BuildInfo {",
      "  /** Full object name of the commit this artifact was built from, or \"unknown\". */",
      "  commit: string;",
      "  /** First 7 characters of `commit`, or \"unknown\". */",
      "  shortCommit: string;",
      "  /** ISO 8601 instant at which this module was generated. */",
      "  builtAt: string;",
      "  /** Uncommitted changes present at build time; null when git could not be consulted. */",
      "  dirty: boolean | null;",
      "}",
      "",
      "export const buildInfo: BuildInfo = {",
      `  commit: ${JSON.stringify(info.commit)},`,
      `  shortCommit: ${JSON.stringify(info.shortCommit)},`,
      `  builtAt: ${JSON.stringify(info.builtAt)},`,
      `  dirty: ${JSON.stringify(info.dirty)},`,
      "};",
    ].join("\n") + "\n"
  );
}

const outFile = resolve(process.argv[2] ?? resolve(REPO_ROOT, "src", "buildinfo.ts"));
const gitDir = resolve(process.argv[3] ?? REPO_ROOT);

const info = collect(gitDir);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, render(info), "utf8");

// Announce it. This line lands in the CI log, which makes the log itself a
// record of what the artifact claims - useful precisely when someone is asking
// "which build was that". stderr, matching the server's own convention of
// keeping stdout clean.
console.error(
  `[buildinfo] commit=${info.shortCommit} dirty=${info.dirty === null ? UNKNOWN : info.dirty} built=${info.builtAt}`,
);

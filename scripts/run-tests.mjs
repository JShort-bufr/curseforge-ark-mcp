// Enumerate the compiled test files and hand them to node --test explicitly.
//
// This exists because none of the obvious spellings work everywhere:
//
//   node --test "dist/test/*.test.js"   glob expansion inside the test runner
//                                       landed in Node 22. On Node 20 the literal
//                                       string reaches the runner and matches
//                                       nothing, which is how CI caught this.
//   node --test dist/test/*.test.js     relies on the SHELL to expand the glob.
//                                       Fine on sh, silently broken on Windows,
//                                       where npm runs scripts through cmd.exe.
//   node --test dist/test/              Node treats an explicit path as a module
//                                       to load, not a directory to scan, and
//                                       dies with MODULE_NOT_FOUND.
//
// Enumerating in JS is the one spelling that is correct on every supported Node
// (package.json says >=20) and on every platform. package.json claiming Node 20
// support while the test script required Node 22 was a real defect, not a CI
// quirk - the matrix was right to fail.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const TEST_DIR = join("dist", "test");

let files;
try {
  files = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => join(TEST_DIR, name))
    .sort();
} catch (cause) {
  console.error(`Could not read ${TEST_DIR}. Did the build run? (${cause.code ?? cause})`);
  process.exit(1);
}

// An empty run must fail loudly. A test command that silently passes because it
// found nothing is the same class of defect as a leak test passing against an
// empty fixture - it reports success while verifying nothing.
if (files.length === 0) {
  console.error(`No *.test.js files found in ${TEST_DIR}. Refusing to report success.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);

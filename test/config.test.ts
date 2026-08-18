import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { PINNED_ORIGIN } from "../src/allowlist.js";
import { CurseForgeClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { CurseForgeError } from "../src/errors.js";
import { REDACTED, safeSnippet, scrubKey } from "../src/scrub.js";
import { FAKE_API_KEY, testConfig } from "./fixtures.js";

/** ADR-002 §2 (refuse to start), §12.1 (the whole of this repo's redaction). */

describe("§2 — refuse to start without a key", () => {
  test("an absent key refuses, naming BOTH locations checked and the Overwolf application", () => {
    const error = (() => {
      try {
        loadConfig({}, { envFilePath: null, envFileLoaded: false });
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    assert.ok(error instanceof CurseForgeError);
    assert.equal(error.code, "CONFIG");
    assert.match(error.message, /CURSEFORGE_API_KEY/, "the exact variable name");
    assert.match(error.message, /process\.env/, "location 1");
    assert.match(error.message, /\.env/, "location 2");
    assert.match(error.message, /x-api-key/, "the header, so nobody reaches for Bearer");
    assert.match(error.message, /NOT self-service/, "the one fact that makes this credential unusual");
    assert.match(error.message, /Overwolf/);
  });

  test("an empty or whitespace key is treated as absent", () => {
    assert.throws(() => loadConfig({ CURSEFORGE_API_KEY: "" }), /will not start/);
    assert.throws(() => loadConfig({ CURSEFORGE_API_KEY: "   " }), /will not start/);
  });

  test("the .env path is named when one was found, so a reader knows which file to edit", () => {
    const error = (() => {
      try {
        loadConfig({}, { envFilePath: "C:\\somewhere\\.env", envFileLoaded: true });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    assert.ok(error instanceof CurseForgeError);
    assert.match(error.message, /somewhere/);
  });

  test("a key too short for the scrub floor is refused at startup", () => {
    // Otherwise it would be the one value that could survive into an error string,
    // because scrubKey deliberately ignores anything under 8 characters.
    assert.throws(() => loadConfig({ CURSEFORGE_API_KEY: "abc" }), /too short/);
  });

  test("PREIMAGE: a plausible key loads, and the base is pinned rather than configurable", () => {
    const config = loadConfig({ CURSEFORGE_API_KEY: FAKE_API_KEY, CURSEFORGE_API_BASE: "https://evil.invalid" });
    assert.equal(config.apiKey, FAKE_API_KEY);
    assert.equal(config.apiBase, PINNED_ORIGIN, "CURSEFORGE_API_BASE is not read at all — the host pin is a control");
  });

  test("no gameId can be configured — only a slug (§5)", () => {
    const config = loadConfig({ CURSEFORGE_API_KEY: FAKE_API_KEY, CURSEFORGE_GAME_SLUG: "some-slug" });
    assert.equal(config.gameSlug, "some-slug");
    assert.equal("gameId" in config, false, "a hardcodable gameId is exactly what §5 forbids");
  });

  test("a client handed an off-pin base refuses to construct", () => {
    assert.throws(
      () => new CurseForgeClient(testConfig({ apiBase: "https://api.example.invalid" })),
      /pinned to https:\/\/api\.curseforge\.com/,
    );
  });
});

describe("§12.1 — the key never survives into a message", () => {
  test("PREIMAGE: the key IS present in the string before scrubbing", () => {
    const raw = `fetch failed for https://api.curseforge.com with key ${FAKE_API_KEY} attached`;
    assert.ok(raw.includes(FAKE_API_KEY), "without this, the assertion below could pass against an empty string");
    const scrubbed = scrubKey(raw, FAKE_API_KEY);
    assert.equal(scrubbed.includes(FAKE_API_KEY), false);
    assert.match(scrubbed, /\[redacted:api-key\]/);
  });

  test("every occurrence goes, not just the first", () => {
    const scrubbed = scrubKey(`${FAKE_API_KEY} and again ${FAKE_API_KEY}`, FAKE_API_KEY);
    assert.equal(scrubbed, `${REDACTED} and again ${REDACTED}`);
  });

  test("a short or absent key does not shred the message", () => {
    assert.equal(scrubKey("abcabcabc", "abc"), "abcabcabc", "a 3-char 'key' would match everywhere");
    assert.equal(scrubKey("unchanged", null), "unchanged");
    assert.equal(scrubKey("unchanged", undefined), "unchanged");
  });

  test("snippets are bounded AND scrubbed", () => {
    const body = `${"a".repeat(400)}${FAKE_API_KEY}`;
    const snippet = safeSnippet(body, FAKE_API_KEY);
    assert.equal(snippet.length, 300);
    assert.equal(snippet.includes(FAKE_API_KEY), false);
  });
});

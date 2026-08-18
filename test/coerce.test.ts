import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { asArray, asBool, asNumber, asString, at, describeCompleteness } from "../src/coerce.js";

/** ADR-002 §6 — empty, absent, and unknown are three states and are never conflated. */

describe("§6 — absent is null, NEVER 0 / \"\" / []", () => {
  test("numbers", () => {
    assert.equal(asNumber(0), 0, "a real zero survives");
    assert.equal(asNumber(undefined), null);
    assert.equal(asNumber(null), null);
    assert.equal(asNumber(Number.NaN), null);
    assert.equal(asNumber("12"), null, "a string where a number belongs is a WRONG FIELD PATH signal, not a value");
  });

  test("booleans", () => {
    assert.equal(asBool(false), false, "a real false survives");
    assert.equal(asBool(undefined), null);
    assert.equal(asBool("true"), null, "no string coercion: CurseForge's schema is typed, unlike Nitrado's");
  });

  test("strings", () => {
    assert.equal(asString(""), "", "an intentional empty string survives");
    assert.equal(asString(undefined), null);
    assert.equal(asString(42), null);
  });

  test("arrays: [] means 'none', null means 'the field was not there'", () => {
    assert.deepEqual(asArray([]), [], "the API said none");
    assert.equal(asArray(undefined), null, "the API did not say");
    assert.equal(asArray({}), null);
  });

  test("nested reads never throw on a missing branch", () => {
    assert.equal(at({ links: { websiteUrl: "u" } }, "links", "websiteUrl"), "u");
    assert.equal(at({}, "links", "websiteUrl"), undefined);
    assert.equal(at(null, "links"), undefined);
  });
});

describe("§4.3 / §3 — the completeness sentence", () => {
  test("an unreachable tail says so in those words, and advises narrowing", () => {
    const note = describeCompleteness({
      index: 0,
      page_size: 50,
      result_count: 50,
      total_count: 50_000,
      has_more: true,
      tail_unreachable: true,
    });
    assert.match(String(note), /TAIL OF THIS RESULT SET IS UNREACHABLE/);
    assert.match(String(note), /Narrow the filter/);
  });

  test("more results says page forward", () => {
    const note = describeCompleteness({
      index: 0,
      page_size: 50,
      result_count: 50,
      total_count: 120,
      has_more: true,
      tail_unreachable: false,
    });
    assert.match(String(note), /More results exist/);
  });

  test("unknown completeness says UNKNOWN rather than assuming completeness", () => {
    const note = describeCompleteness({
      index: 0,
      page_size: 50,
      result_count: 50,
      total_count: null,
      has_more: null,
      tail_unreachable: null,
    });
    assert.match(String(note), /UNKNOWN/);
  });

  test("a complete page gets NO note — an unconditional note trains the reader to skip it", () => {
    const note = describeCompleteness({
      index: 0,
      page_size: 50,
      result_count: 12,
      total_count: 12,
      has_more: false,
      tail_unreachable: false,
    });
    assert.equal(note, null);
  });

  test("no page descriptor at all gets no note", () => {
    assert.equal(describeCompleteness(null), null);
  });
});

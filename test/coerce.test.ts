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

describe("2026-08-18 live finding — paging past the end", () => {
  /**
   * Observed: at index 9950 on a 6848-result query, CurseForge returned
   * resultCount 0 AND totalCount 0. `totalCount` is a property of the RESPONSE,
   * not of the query. Without this branch the descriptor would read
   * total_count 0 / has_more false, which a model would take as "this search
   * found nothing" rather than "you walked off the end".
   */
  test("index > 0 with zero results says PAST THE END, and warns that totalCount 0 is not the query's total", () => {
    const note = describeCompleteness({
      index: 9_950,
      page_size: 50,
      result_count: 0,
      total_count: 0,
      has_more: false,
      tail_unreachable: false,
    });
    assert.match(String(note), /PAST THE END OF THE RESULT SET/);
    assert.match(String(note), /property of THIS response/);
    assert.match(String(note), /Do NOT read this as "the search found nothing"/);
  });

  test("PREIMAGE: a zero-result FIRST page is still the ordinary 'none matched' answer, with no such warning", () => {
    // index 0 with 0 results is a real empty search (§6) and must not be dressed
    // up as a paging accident.
    const note = describeCompleteness({
      index: 0,
      page_size: 50,
      result_count: 0,
      total_count: 0,
      has_more: false,
      tail_unreachable: false,
    });
    assert.equal(note, null);
  });
});

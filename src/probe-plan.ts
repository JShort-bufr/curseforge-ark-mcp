/**
 * THE PROBE PLAN, with the 2026-08-18 verdict on each row.
 *
 * One entry per §14.3 row, so the plan is checkable against the register rather
 * than hand-maintained: a test asserts every row U1..U13 appears here, which is
 * what stops this list drifting behind the ADR.
 *
 * AMENDED 2026-08-18 by office-backend-engineer. `status` was added because the
 * plan is now also a status board: nine rows closed, four did not, and a plan
 * that still reads as though nothing has been checked is the same defect as a
 * disclaimer that has gone false.
 */
export type ProbeStatus = "RESOLVED" | "STILL OPEN";

export interface ProbeStep {
  row: string;
  claim: string;
  probe: string;
  status: ProbeStatus;
  /** What was actually seen on 2026-08-18. Never a guess, and never a value that was not observed. */
  finding: string;
}

export const PROBE_PLAN: readonly ProbeStep[] = [
  {
    row: "U1",
    claim: "The ASA gameId value",
    probe: "GET /v1/games, then match the slug/name candidates",
    status: "RESOLVED",
    // The resolved id is recorded in ADR-002 §14.3 and in the README, and it is
    // NOT repeated here as a string literal. The rule this obeys is not
    // squeamishness: src/ is scanned for that literal outside comments, because
    // the failure a hardcoded gameId produces is a clean, empty, entirely wrong
    // search result set rather than an error. A number sitting in a findings
    // table is one copy-paste away from being the number a request uses.
    finding:
      "Resolved. Slug ark-survival-ascended, name 'ARK Survival Ascended' (no colon — an exact match on the " +
      "colonised spelling would have failed). The numeric id is recorded in ADR-002 §14.3, deliberately not " +
      "here; get_api_diagnostics prints the value it resolved live this run.",
  },
  {
    row: "U2",
    claim: "Whether ASA is visible to the granted key at all",
    probe: "GET /v1/games — if ASA is absent from the list, that is v1-blocking and goes back to the board",
    status: "RESOLVED",
    finding: "Visible. 38 games returned for this key, ASA among them. NOT v1-blocking.",
  },
  {
    row: "U3",
    claim: "Mod field paths",
    probe: "GET /v1/mods/search, then read one mod record field by field",
    status: "RESOLVED",
    finding: "All ten paths present and correctly typed across 300 sampled mods. None needed correcting.",
  },
  {
    row: "U4",
    claim: "File field paths",
    probe: "GET /v1/mods/{modId}/files on the first search hit",
    status: "RESOLVED",
    finding: "All ten paths present across 1899 files. None needed correcting. Nested sortableGameVersions shape now mirrored in the fixtures.",
  },
  {
    row: "U5",
    claim: "FileDependency = { modId, relationType }",
    probe: "inspect dependencies[] on any file that has one",
    status: "STILL OPEN",
    finding: "UNOBSERVED — not wrong, never seen. 0 of 1899 files declared a dependency, so no edge object has ever been inspected.",
  },
  {
    row: "U6",
    claim: "The FileRelationType numeric enum mapping",
    probe:
      "collect every DISTINCT relationType integer observed across many mods. NOTE: this probe can only " +
      "enumerate values, never label them. If no source publishes the table, §7.2's unmapped-integer " +
      "behaviour is the ANSWER and not a stopgap",
    status: "STILL OPEN",
    finding:
      "Unpublished AND unobservable in this catalog: dependencies was present-and-empty on all 1899 files " +
      "across 748 mods, so no relationType integer has ever appeared. The predicted outcome; §7.2's " +
      "unmapped-integer traversal is therefore the settled answer.",
  },
  {
    row: "U7",
    claim: "The FileReleaseType numeric enum",
    probe: "collect every distinct releaseType integer, and cross-check against files whose displayName says alpha/beta",
    status: "STILL OPEN",
    finding:
      "Integers 1 (1893 files), 2 (3) and 3 (3) observed. At least three members; WHICH is release/beta/alpha " +
      "is still unknown. A frequency distribution is not a value table.",
  },
  {
    row: "U8",
    claim: "Whether pagination is present on every paginated endpoint",
    probe: "GET /v1/games and /v1/mods/search — the client already errors if it is absent",
    status: "RESOLVED",
    finding: "Present on E1/E2/E4; absent on E3/E5/E6/E7 (they return {data} only). The client's split is correct as built.",
  },
  {
    row: "U9",
    claim: "Whether ASA mods populate dependencies, sortableGameVersions, latestFilesIndexes",
    probe: "count how many of N sampled mods have each field non-empty. An always-empty field is a capability gap, not a bug",
    status: "RESOLVED",
    finding:
      "latestFiles / latestFilesIndexes / sortableGameVersions / gameVersions: 300 of 300. dependencies: " +
      "present on 100%, non-empty on 0%. A capability gap, recorded as one.",
  },
  {
    row: "U10",
    claim: "Any vendor id-count cap on the bulk POSTs",
    probe: "POST /v1/mods with a large id array and see what it says. Our own cap is 200 and is not the vendor's",
    status: "STILL OPEN",
    finding: "No cap found up to 300 distinct ids (HTTP 200, 300 records returned). A probe that found no ceiling has not found the ceiling.",
  },
  {
    row: "U11",
    claim: "CurseForge rate limits",
    probe: "read response headers on every probe; get_api_diagnostics reports whatever appeared",
    status: "RESOLVED",
    finding:
      "CurseForge sends NO rate-limit header of any name, on GET or POST — transport/CDN headers only. " +
      "Still not a claim that no limit exists; the self-imposed pacing stays.",
  },
  {
    row: "U12",
    claim: "Real pagination behaviour past index 0 and at the 10000 ceiling",
    probe: "GET /v1/mods/search at index 0 and at a high index; observe totalCount vs reachability",
    status: "RESOLVED",
    finding:
      "Stable totalCount 6848 across index 0-250. Past the end of a result set, CurseForge returns " +
      "resultCount 0 AND totalCount 0 — totalCount describes the RESPONSE, not the query. Not anticipated by " +
      "the ADR; describeCompleteness now has a past-the-end branch.",
  },
  {
    row: "U13",
    claim: "Base URL https://api.curseforge.com",
    probe: "any successful call at all confirms the host",
    status: "RESOLVED",
    finding: "Correct. Every probe succeeded against it; the host pin is sound.",
  },
];

/** The rows measurement has not closed. Derived, so it cannot drift from the table above. */
export function openRows(): readonly ProbeStep[] {
  return PROBE_PLAN.filter((step) => step.status === "STILL OPEN");
}

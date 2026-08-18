/**
 * THE PROBE PLAN. One entry per §14.3 row, so the plan is checkable against the
 * register rather than hand-maintained: the test suite asserts that every row
 * U1..U13 appears here, which is what stops this list quietly drifting behind
 * the ADR.
 */
export interface ProbeStep {
  row: string;
  claim: string;
  probe: string;
}

export const PROBE_PLAN: readonly ProbeStep[] = [
  { row: "U1", claim: "The ASA gameId value", probe: "GET /v1/games, then match the slug/name candidates" },
  {
    row: "U2",
    claim: "Whether ASA is visible to the granted key at all",
    probe: "GET /v1/games — if ASA is absent from the list, that is v1-blocking and goes back to the board",
  },
  { row: "U3", claim: "Mod field paths", probe: "GET /v1/mods/search, then read one mod record field by field" },
  { row: "U4", claim: "File field paths", probe: "GET /v1/mods/{modId}/files on the first search hit" },
  { row: "U5", claim: "FileDependency = { modId, relationType }", probe: "inspect dependencies[] on any file that has one" },
  {
    row: "U6",
    claim: "The FileRelationType numeric enum mapping",
    probe:
      "collect every DISTINCT relationType integer observed across many mods. NOTE: this probe can only " +
      "enumerate values, never label them. If no source publishes the table, §7.2's unmapped-integer " +
      "behaviour is the ANSWER and not a stopgap",
  },
  {
    row: "U7",
    claim: "The FileReleaseType numeric enum",
    probe: "collect every distinct releaseType integer, and cross-check against files whose displayName says alpha/beta",
  },
  { row: "U8", claim: "Whether pagination is present on every paginated endpoint", probe: "GET /v1/games and /v1/mods/search — the client already errors if it is absent" },
  {
    row: "U9",
    claim: "Whether ASA mods populate dependencies, sortableGameVersions, latestFilesIndexes",
    probe: "count how many of N sampled mods have each field non-empty. An always-empty field is a capability gap, not a bug",
  },
  { row: "U10", claim: "Any vendor id-count cap on the bulk POSTs", probe: "POST /v1/mods with a large id array and see what it says. Our own cap is 200 and is not the vendor's" },
  { row: "U11", claim: "CurseForge rate limits", probe: "read response headers on every probe; get_api_diagnostics reports whatever appeared" },
  { row: "U12", claim: "Real pagination behaviour past index 0 and at the 10000 ceiling", probe: "GET /v1/mods/search at index 0 and at a high index; observe totalCount vs reachability" },
  { row: "U13", claim: "Base URL https://api.curseforge.com", probe: "any successful call at all confirms the host" },
];

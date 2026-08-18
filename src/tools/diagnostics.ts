import { type BuildInfo, buildInfo } from "../buildinfo.js";
import { ENDPOINT_ALLOWLIST, MAX_ADDRESSABLE_RESULTS, MAX_BULK_IDS, MAX_PAGE_SIZE, PINNED_ORIGIN, POST_CAPABLE_TOOLS } from "../allowlist.js";
import { CurseForgeError } from "../errors.js";
import { openRows } from "../probe-plan.js";
import type { ToolDef } from "../registry.js";
import { verificationBlock, type ToolContext } from "./context.js";

/**
 * Say what the build stamp does and does not prove.
 *
 * Ported from the sibling repo, including its choice to return null in the clean
 * case: an unconditional note trains the reader to skip it, and then the dirty
 * warning goes unread.
 */
export function describeBuild(info: BuildInfo): string | null {
  if (info.commit === "unknown") {
    return (
      "This artifact was built with no git available — a tarball or a plain source copy — so it cannot name " +
      "the commit it came from. `dirty` is null for the same reason: unknown, not clean."
    );
  }
  if (info.dirty === true) {
    return (
      "Built from a working tree carrying uncommitted or untracked changes, so `commit` does NOT fully " +
      "describe the running code. Diff the tree against that commit before trusting it."
    );
  }
  if (info.dirty === null) {
    return (
      "The commit is known, but the working tree could not be checked at build time, so whether this build " +
      "matches that commit exactly is unknown."
    );
  }
  return null;
}

/**
 * `get_api_diagnostics` — E1, and the HONEST-STATUS tool (ADR-002 §7.3).
 *
 * This is where a caller finds out it is talking to an UNVERIFIED client, so it
 * says so rather than implying health. Note what it never reports: the key, a
 * prefix of the key, or its length. "Configured: yes" is the entire answer.
 */
export function diagnosticsTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "get_api_diagnostics",
      title: "Diagnose this server's CurseForge connection and honesty posture",
      tier: 1,
      description:
        "Answers 'is it me, the key, or CurseForge?' in one call: whether a key is configured (never the key " +
        "itself, nor a prefix, nor its length), whether GET /v1/games succeeded, which ARK: Survival " +
        "Ascended gameId was resolved and how, which commit this build came from and whether that build was " +
        "dirty, what the endpoint allow-list currently permits, and any rate-limit headers a real response " +
        "actually carried. It also reports the VERSION POSTURE: this is v0 and every field path in every " +
        "tool is a hypothesis. Run this first when other tools behave strangely. Read-only.",
      inputSchema: {},
      handler: async () => {
        let games: { ok: true; value: unknown } | { ok: false; error: string };
        try {
          games = { ok: true, value: await ctx.games.resolve() };
        } catch (error) {
          games = { ok: false, error: error instanceof CurseForgeError ? error.message : String(error) };
        }

        return {
          version_posture: {
            version: "0.2.0",
            stage: "v0 — PARTIALLY verified",
            // Not a boolean any more, and that is the honest shape. "verified:
            // true" would be false and "verified: false" is now also false; the
            // useful answer names which half.
            field_paths_verified: "mod-and-file-core-fields-yes; dependency-edge-shape-no",
            first_live_verification: "2026-08-18",
            // Derived from the probe plan, not restated. Two hand-maintained lists
            // of "what is still open" would eventually disagree, and the one in a
            // diagnostics tool is the one a reader would believe.
            unresolved_rows: openRows().map((row) => row.row),
            note:
              `This client made its first authenticated calls on 2026-08-18 and every Mod and File path it ` +
              `reads was confirmed present in live responses — none needed correcting. It is STILL v0, because ` +
              `${openRows().length} rows of the register remain unconfirmed and one of them is not merely ` +
              `unchecked but unobservable: the FileDependency edge shape was never seen (0 dependency edges in ` +
              `1899 sampled ASA files), and neither the relationType nor the releaseType integer meanings are ` +
              `published. Do not read a partially confirmed client as a verified one. The \`verification\` ` +
              `block on any tool result carries the sample sizes.`,
            unverified_claims_register: "docs/adr/ADR-002-endpoint-allow-list.md §14.3, and the README table",
          },
          credential: {
            // Boolean only. Never the value, never a prefix, never a length — a
            // length is a real hint to an attacker and buys the reader nothing
            // they cannot get from "is it set?".
            configured: ctx.config.apiKey.length > 0,
            header: "x-api-key",
            not_bearer:
              "This server authenticates with the x-api-key header. It deliberately does NOT support " +
              "Authorization: Bearer — that is the sibling Nitrado server's scheme, and supporting both would " +
              "mean this code could send the key in a form CurseForge never documented.",
            self_service: false,
            note:
              "A CurseForge key is granted by application to Overwolf and is non-transferable. A leak means " +
              "revoke and REAPPLY, and reapplication is a queue rather than a self-service reset. CurseForge " +
              "publishes no read-only scope and no scope selection, so there is no narrower key to ask for — " +
              "the read-only property of this server comes from its own endpoint allow-list, not from the key.",
          },
          game_resolution: games.ok
            ? { resolved: true, ...(games.value as Record<string, unknown>) }
            : {
                resolved: false,
                error: games.error,
                note:
                  "The ARK: Survival Ascended gameId is resolved at runtime and is NEVER hardcoded or guessed " +
                  "(ADR-002 §5). Until it resolves, search_mods cannot run — which is the correct behaviour: a " +
                  "guessed gameId would return a clean, empty, entirely wrong result set instead of an error.",
              },
          build: {
            commit: buildInfo.commit,
            short_commit: buildInfo.shortCommit,
            built_at: buildInfo.builtAt,
            dirty: buildInfo.dirty,
            caveat: describeBuild(buildInfo),
          },
          transport: {
            pinned_origin: PINNED_ORIGIN,
            chokepoint: "src/allowlist.ts — a closed allow-list of {method, path} pairs, matched jointly",
            // `shape` already carries the method. Concatenating entry.method as
            // well printed "E1 GET GET /v1/games" in the first live run — caught
            // by reading the output rather than by any test, which is its own
            // small lesson about what a test suite over synthetic data can see.
            allowlist: ENDPOINT_ALLOWLIST.map((entry) => `${entry.id} ${entry.shape}`),
            allowlist_size: ENDPOINT_ALLOWLIST.length,
            post_capable_tools: POST_CAPABLE_TOOLS,
            refused_by_design: [
              "GET /v1/mods/{modId}/files/{fileId}/download-url — a documented read on the pinned host, " +
                "refused because it is not on the allow-list. No download or install tool exists here.",
              "Every write, on every host: no allow-list entry names a mutating endpoint, and the pin refuses " +
                "the documented CurseForge upload API a second time for an independent reason.",
              "Every Nitrado call: this server holds no Nitrado credential and reads no Nitrado config.",
            ],
            bounds: {
              max_page_size: MAX_PAGE_SIZE,
              max_addressable_results: MAX_ADDRESSABLE_RESULTS,
              max_bulk_ids: MAX_BULK_IDS,
              max_bulk_ids_note:
                "The bulk-id cap is OURS, not CurseForge's. No vendor cap is documented and none has been " +
                "observed (ADR-002 §14.3 U10).",
            },
          },
          rate_limit: {
            // Observed headers or null. NEVER a guess, and never 0.
            observed: ctx.client.lastRateLimit,
            note:
              ctx.client.lastRateLimit === null
                ? "No rate-limit header has been observed in this process. That is NOT a claim that there is no " +
                  "limit — CurseForge publishes no rate-limit figure at all (ADR-002 §14.3 U11), and no request " +
                  "in this process has yet returned a header this client recognises. Absent is not zero."
                : "These are the raw headers as received, unparsed. CurseForge documents no rate limit, so " +
                  "parsing them into a {limit, remaining} shape would assert a contract nobody here has " +
                  "observed.",
            measured_2026_08_18:
              "A live GET and a live POST were inspected header by header. CurseForge returned NO rate-limit " +
              "header of any name — the full response header set was transport and CDN only (content-type, " +
              "date, vary, via, x-amz-cf-id, x-amz-cf-pop, x-cache, x-cf-ver). So `observed: null` is not a " +
              "gap in this client's header matching; there is nothing being sent. It remains NOT a claim that " +
              "no limit exists: an unadvertised limit is still a limit, and the self-imposed pacing stays.",
          },
          verification: verificationBlock(),
        };
      },
    },
  ];
}

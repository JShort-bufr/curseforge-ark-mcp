# curseforge-ark-mcp

**A read-only MCP server for CurseForge mod curation, discovery, and update surveillance for
ARK: Survival Ascended.**

> ## THIS IS STILL v0 — PARTIALLY VERIFIED, NOT VERIFIED.
>
> **What changed on 2026-08-18:** the CurseForge API key arrived, the client made its first
> authenticated calls, and **every `Mod` and `File` field path it reads was confirmed present
> in live responses. None needed correcting.** Sample: 748 distinct ARK: Survival Ascended
> mods, 1899 file records.
>
> **Why it is still v0.** Four things remain unconfirmed, and one of them cannot be confirmed
> by looking:
>
> - The **`FileDependency` edge shape** has never been observed — 0 of 1899 sampled ASA files
>   declared a dependency, with the `dependencies` array present and empty every time.
> - The **`FileRelationType`** integers are unpublished *and* unexercised in this catalog.
> - The **`FileReleaseType`** integers `1`, `2` and `3` have now been seen. Which one means
>   release, beta or alpha is still unknown, and this server will not guess.
> - Any **vendor cap** on bulk-read id arrays: none found up to 300 ids, so none is known.
>
> A partially verified client is not a verified one. The version number is a claim about
> verification status, so it is `0.2.0` — not `1.0.0`, and deliberately not `1.0.0-anything`.

This repo's own behaviour is verified independently of the API: the endpoint allow-list, the
host pin, the path normalization, the pagination bounds, the envelope handling, and the
three-state absent/empty/unknown discipline. All of it is tested against an injected fake
`fetch`, with no key and no network. **160 tests, 0 failures** at the time of writing.

Design record: [`docs/adr/ADR-002-endpoint-allow-list.md`](docs/adr/ADR-002-endpoint-allow-list.md)
(status: **ACCEPTED 2026-08-18, with known-open residuals** — not a verified catalog).
Every section reference below (§1, §4.3, §14.3 …) points into it.

---

## What it does, and what it deliberately cannot do

Seven tools, all read-only:

| Tool | Answers |
| --- | --- |
| `search_mods` | "Which ASA mods match this term?" |
| `get_mod` | "What is project 777001?" |
| `list_mod_files` | "What files has this mod published?" |
| `get_mod_file` | "What is this specific file?" |
| `get_latest_file` | **"Is there a newer file for this mod than the one I am running?"** |
| `resolve_mod_dependencies` | "What does this mod pull in?" (batched, one request per tree level) |
| `get_api_diagnostics` | "Is it me, the key, or CurseForge?" — and "how honest is this build?" |

It **cannot**:

- **Download or install anything.** `GET /v1/mods/{modId}/files/{fileId}/download-url` is a
  documented read, on the pinned host, and it is **refused** — because it is not on the endpoint
  allow-list (DEC-002 §11.3). Nitrado installs mods itself.
- **Write anything, anywhere.** No allow-list entry names a mutating endpoint. CurseForge does
  operate a mutating upload API on a different host (§14.2); the host pin refuses it a second
  time for an independent reason.
- **Publish or author a mod.** Refused outright (DEC-002 Ruling 2). Enforced by a boot
  assertion, not by a promise: registering a tool that declares anything other than tier 1 makes
  the process **refuse to start**.
- **Touch Nitrado.** No `NITRADO_*` variable exists in this repo's configuration surface, and
  its absence is a control. This server holds no Nitrado token and reads no Nitrado config.
- **Wake up on a timer and update your server.** No scheduler, no polling loop, no persisted
  "last seen version" state (§10). Surveillance means the model may *observe* a new version. It
  does not get to act.

---

## The chokepoint: an endpoint allow-list, not a method check

This is the one design decision worth reading before touching the code.

CurseForge **uses POST to READ**. `POST /v1/mods` and `POST /v1/mods/files` are bulk
retrievals, and they are what make `resolve_mod_dependencies` cost one request per dependency
*level* instead of one per *node*. So the sibling repo's `method !== "GET" → refuse` would fail
here in the most expensive way possible: **it would work.** It would refuse things, pass its own
tests, and quietly make the server bad at its job.

And the obvious fix is worse than the bug:

```
allowed = { GET }          → the batch reads are refused (broken, loudly)
allowed = { GET, POST }    → every request this client can construct is allowed
```

The documented catalog API contains only `GET` and `POST`. A gate admitting both admits
everything — **while continuing to look present**.

So instead, every outbound request must match an explicit entry in a closed list of
`{method, path}` pairs. Seven entries, in [`src/allowlist.ts`](src/allowlist.ts):

| # | Method | Path | Serves |
| --- | --- | --- | --- |
| E1 | `GET` | `/v1/games` | game-id resolution, `get_api_diagnostics` |
| E2 | `GET` | `/v1/mods/search` | `search_mods` |
| E3 | `GET` | `/v1/mods/{modId}` | `get_mod`, `get_latest_file` |
| E4 | `GET` | `/v1/mods/{modId}/files` | `list_mod_files`, `get_latest_file` |
| E5 | `GET` | `/v1/mods/{modId}/files/{fileId}` | `get_mod_file` |
| E6 | `POST` | `/v1/mods` | `resolve_mod_dependencies` (bulk read) |
| E7 | `POST` | `/v1/mods/files` | `resolve_mod_dependencies` (bulk read) |

Mechanically:

- **Matched on `{method, path}` jointly.** E3 does not authorise `DELETE /v1/mods/123`. E6 does
  not authorise `POST /v1/mods/123`.
- **The host is pinned** to `https://api.curseforge.com`, and the pin is an *allow* of one
  origin rather than a deny of any named other.
- **Id segments bind to `[0-9]+`, not `[^/]+`.** This is load-bearing: a permissive `{modId}`
  makes E3 swallow `/v1/mods/search`. The numeric binding makes that ambiguity *structurally
  impossible* rather than dependent on match order — and there is a test that reverses the whole
  list to prove ordering is not what saves it.
- **One normalization, before the check**, and the URL is built from its output. Percent-decode
  once; refuse any `%` that survives; fold backslashes; refuse `.`, `..` and empty segments.
- **Only E6/E7 may carry a body**, shape-checked before dispatch. A body on a GET entry is
  refused, not dropped.
- **Only `resolve_mod_dependencies` may reach a POST entry** (§8), enforced in the transport.

**The failure mode is "unmatched request refused", never "unrecognised request sent."** And
adding a capability is a reviewable one-line diff whose review question — *"is this endpoint a
read?"* — is one a human can actually answer.

### The test that proves it is an allow-list

`GET /v1/mods/{modId}/files/{fileId}/download-url` is **refused**. It is a documented read, a
`GET`, on the pinned host, with well-formed numeric ids. It is refused *purely* because it is not
on the list. If that test ever passes for some other reason — a host-pin refusal, a path
refusal — the property is not implemented, so the test asserts the refusal's *code and detail*,
not merely that something threw.

Every refusal test also asserts the fake `fetch`'s **call count**, because "refused before the
request is built" is the actual provision, and an error thrown *after* dispatch would satisfy a
weaker assertion. And the refusal suite is preceded by a **preimage** test proving all seven
entries do dispatch — a refusal suite over a client that can send nothing passes perfectly and
proves nothing.

---

## Verified against the live API — 2026-08-18

Sample: **748 distinct ASA mods, 1899 file records**, drawn from deep search pages
(index 1000-6000) and from every documented `sortField` 1-12, plus full file lists for 100 mods.
Dated and sized on purpose: "verified" without a sample size is a mood, not a claim.

| # | Claim | Result |
| --- | --- | --- |
| U1 | The ASA `gameId` | **`83374`**, slug `ark-survival-ascended`, name `ARK Survival Ascended` — **no colon**, which an exact-match spelling would have got wrong. Still resolved live on every start; a test asserts the number appears nowhere in `src/` outside a comment. |
| U2 | Is ASA visible to the key? | **Yes.** 38 games visible, ASA among them. Not v1-blocking. |
| U3 | `Mod` field paths | **All correct.** `id`, `gameId`, `name`, `slug`, `dateModified`, `links.websiteUrl`, `categories`, `allowModDistribution`, `latestFiles`, `latestFilesIndexes`. |
| U4 | `File` field paths | **All correct.** `id`, `modId`, `displayName`, `fileName`, `fileDate`, `gameVersions`, `sortableGameVersions`, `dependencies`, `releaseType`, `isAvailable`. |
| U8 | `pagination` presence | Present on the paginated endpoints (games, search, files), absent on single-record and bulk reads — which is exactly the split this client was built to expect. |
| U9 | Do ASA mods populate the optional fields? | `latestFiles`, `latestFilesIndexes`, `sortableGameVersions`, `gameVersions`: **300/300**. `dependencies`: present on 100%, non-empty on **0%**. |
| U11 | Rate-limit headers | **CurseForge sends none.** Full header enumeration on a live GET and POST found transport/CDN headers only. So `null` is not a matching bug in this client — but it is **not** a claim that no limit exists, and the self-imposed pacing stays. |
| U12 | Pagination past index 0 | Works; `totalCount` stable at 6848 across pages. **But** past the end of a result set CurseForge returns `resultCount: 0` *and* `totalCount: 0` — `totalCount` describes the response, not the query. Tool output now says "past the end" rather than letting that read as "found nothing". |
| U13 | Base URL | Correct. The host pin is sound. |

**No field path needed correcting.** That is recorded as an outcome rather than a boast: the
sibling repo's commit `5481c04` fixed three wrong paths the day it first called live, and that
precedent is the reason each path here was checked one at a time instead of trusted.

## Still unverified

Shrunk, not vanished. These are the rows that survived contact with the live API.

| # | Claim | Status | Why it is still open |
| --- | --- | --- | --- |
| **U5** | `FileDependency` = `{ modId, relationType }` | **Unobserved** | Not shown wrong — *never seen*. No ASA file in the sample declared a dependency, so no edge object has ever been inspected. The shape is documentation-derived and the test fixture is the only place it exists. |
| **U6** | The **`FileRelationType`** numeric enum | **Unpublished AND unobservable here** | `dependencies` was present-and-empty on all 1899 files across 748 mods, so no relation integer has ever appeared. ADR-002 predicted this and named the consequence: the unmapped-integer traversal is **the answer, not a stopgap**. Practical effect: for ASA, `resolve_mod_dependencies` returns single-node trees, and it now says so in its own output so an empty tree does not read as a failure. |
| **U7** | The **`FileReleaseType`** numeric enum | **Values seen, meanings unknown** | Observed: `1` (1893 files), `2` (3), `3` (3). At least three members, consistent with the Upload API's alpha/beta/release trio — and no evidence at all about which integer is which. A frequency distribution is not a value table. Inferring `1 = release` because 1 is commonest is the guess this repo exists to refuse. |
| **U10** | Vendor cap on bulk-read id arrays | **No cap found up to 300** | 200 distinct ids returned 200 records; 300 returned 300. So the cap, if any, is above 300. The 200-id cap in this client stays: it is ours, deliberately conservative against an undocumented rate limit, and a probe that found no ceiling has not found the ceiling. |

### Two consequences you will see in tool output

**`relationType` and `releaseType` are surfaced as raw integers and are never mapped.** Not to
`required`/`optional`, not to `release`/`beta`/`alpha`. CurseForge publishes no value table for
either, and a wrong label would produce a dependency list — or an update recommendation — that is
wrong in a way nobody would check. `resolve_mod_dependencies` therefore follows **every** edge
and says so: it **over-collects**, and its output states that plainly. A wide net is at least
visibly wide.

For ASA specifically, the live catalog makes that moot in a way worth knowing before you use the
tool: **no sampled ASA mod declares any dependency at all.** A single-node tree is the expected
result, not a symptom of a broken traversal, and the tool's output says which one it is.

**`get_latest_file` defaults to newest by `fileDate`.** Newest by `fileDate`, newest
matching a game version, and newest with a given `releaseType` still give *different
answers*, and a mod-update decision made on the wrong one is exactly the
confident-wrong-answer class this repo is arranged against. The founder settled the
default on 2026-08-18: omit `selection` and you get `newest_by_file_date`. The other two
variants remain. Every answer restates the ordering it used, whether the default was
applied, what it filtered on, how many candidates it considered, and where the candidates
came from.

| `selection` | Also requires | Means |
| --- | --- | --- |
| `newest_by_file_date` | — | **Default.** Newest of all candidate files, by `fileDate` |
| `newest_matching_game_version` | `game_version` | Newest file declaring that game version |
| `newest_with_release_type` | `release_type` (a raw **integer**) | Newest file carrying that release-type integer |

There is no named `release`/`beta`/`alpha` filter, because U7 is unresolved and this server will
not invent the mapping. You pass the integer you mean.

ADR-002 open question 2 is closed as a product decision, not as a verification claim. The
tool is still parameterized: the default is one of three stated questions, not a rewrite
that deletes the other two.

---

## Setup

Node 20+ (developed on 22). No build step to configure; `npm test` builds first.

```bash
npm install
npm test          # builds, then runs the suite — no key, no network, nothing live
npm run typecheck
npm run smoke     # LIVE once a key is configured; refuses cleanly and probes nothing without one
```

`npm run smoke` is the falsification run, not a health check. With a key it walks the §14.3
register row by row and prints what it observed; without one it names every probe it would have
made and exits 0 having sent nothing. The test suite never touches the network in either case.

MCP client configuration (stdio). First-use on this machine is the Cursor user
`mcp.json` entry `curseforge-ark`. It launches `dist/src/server.js` and does **not**
put the key in that file: the server loads gitignored `.env` itself (process.env
still wins if an MCP client supplies the variable). Duplicating the key into
`mcp.json` is a second copy of a non-transferable credential.

```json
{
  "mcpServers": {
    "curseforge-ark": {
      "command": "node",
      "args": ["C:/Users/jdsho/CursorProjects/curseforge-ark-mcp/dist/src/server.js"]
    }
  }
}
```

Disable / rollback: remove the `curseforge-ark` entry from the MCP client config.
This server is first-party stdio, not a Runlayer-managed catalog server.

**The server refuses to start without a key**, naming both locations it searched, the exact
variable, and the fact that the key is not self-service. A stdio MCP server that starts cleanly
and then throws on all seven tools is a miserable thing to debug.

### About the key

The API key is sent as an **`x-api-key`** request header. It is **not** an
`Authorization: Bearer` token — that is the sibling Nitrado server's scheme, and this repo
deliberately does not support both, because supporting both would mean this code could transmit
the credential in a form CurseForge never documented.

The key is **granted by application to Overwolf and is non-transferable.** The practical
consequence, and the only reason this paragraph exists: **a leak means revoke and re-apply, and
re-application is a queue, not a self-service reset.** You cannot regenerate it over coffee and
you cannot borrow someone else's. Treat it accordingly — `.env` is gitignored, `.env.example`
carries the variable name and an empty value, and no key value appears in any committed file.

**There is no scope matrix in this repo, and that is not an oversight:** CurseForge publishes no
read-only scope and no scope selection, so there is nothing to matrix. The read-only property of
this server comes from its own endpoint allow-list, not from a narrower credential. There is also
no token-leak runbook — a leaked key grants read access to a public catalog plus quota
consumption, which is real and is not the same category as the sibling repo's Nitrado token
(documented as equivalent to full control of a game server). That right-sizing is argued in
ADR-002 §12, and it rests on one claim stated there so it can be falsified: **CurseForge catalog
data is public by construction.**

### Redaction, all of it

One rule: **never echo the API key.** One function, [`src/scrub.ts`](src/scrub.ts), applied to
error messages and to any upstream body snippet. Request headers never appear in errors — not the
key, not a redacted key, not a header-name list. `get_api_diagnostics` reports whether a key is
configured and **never its value, a prefix of it, or its length**.

---

## Behaviours worth knowing before you read output

- **Empty is not unknown.** `data: []` means CurseForge answered "none" — a real answer, with
  the query echoed so you can see what returned nothing. An absent field is `null`, **never** `0`,
  `""` or `[]`. A request that did not complete, or a response whose shape is wrong, is an
  **error** — never a value.
- **A missing `data` key is an error, not an empty result.** Coercing it to `[]` would turn a
  broken integration into "no results found".
- **A missing `pagination` on a paginated endpoint is an error too.** Assuming one page is how a
  tool reports 50 of 900 mods as if it were all of them (U8 is exactly this open question).
- **`pageSize > 50` is refused, not clamped**, and so is `index + pageSize > 10000` — with the
  largest legal page size at that index named in the message. A model that asks for 200 and
  silently gets 50 will reason about a page as if it were a set.
- **When `totalCount` exceeds 10000, tool output says the tail is UNREACHABLE**, in those words,
  and advises narrowing the filter rather than paging.
- **The ASA `gameId` is discovered at runtime** from `GET /v1/games` and cached for the process
  lifetime; it is never hardcoded and never guessed. If it cannot be resolved the server fails
  loudly, naming what it searched for and how many games the key could see — because `gameId` is
  a *required* search filter, so a wrong one returns clean, empty, entirely wrong results instead
  of an error. Set `CURSEFORGE_GAME_SLUG` if the built-in candidates turn out to be wrong.
- **`resolve_mod_dependencies` is bounded** at depth 4 and 400 nodes, with a visited set for
  cycles. When a bound is hit the result is reported as **truncated**, in that word, with the
  unexplored frontier listed.

---

## Repo layout

```
src/
  allowlist.ts    THE CHOKEPOINT — seven entries, host pin, normalization, bounds, body checks
  client.ts       the single transport; the ONLY place x-api-key is attached; envelope unwrap
  config.ts       refuse-to-start; no NITRADO_*, no mode switch, no settable base URL
  coerce.ts       empty / absent / unknown, kept apart
  errors.ts       the error taxonomy
  game.ts         runtime gameId resolution (injected, process-lifetime cache)
  registry.ts     ToolDef + tier, and the boot assertion that refuses a non-tier-1 tool
  scrub.ts        never echo the key. That is the whole module.
  probe-plan.ts   one probe per unverified row, asserted complete by a test
  server.ts       stdio entry point
  smoke.ts        the falsification run (live with a key, plan-only without)
  tools/          the seven tools
test/             156 tests; fixtures are synthetic in content, structural in shape
scripts/          buildinfo generator, test enumerator
```

`src/buildinfo.ts` is **generated and gitignored**, stamped with the commit and a `dirty` flag
before every `tsc` run, and surfaced by `get_api_diagnostics`. `dist/` is gitignored and the
server runs from it as a long-lived process, so "which code produced that answer?" is not
answerable from `git` at runtime — it has to travel with the artifact.

### Deviations from the sibling repo, stated deliberately

ADR-002's open questions 7 and 8 ask for these to be named where they happen:

- **Same baseline, deliberately.** Node ≥20, TypeScript 5.9.3, `@modelcontextprotocol/sdk`
  1.30.0, `zod` 4.4.3, `node:test` via the same `scripts/run-tests.mjs` enumerator. Same
  reviewer, same idioms, lower cost of reading both.
- **`@cfworker/json-schema` is not a dependency here.** It backs the sibling's cron-expression
  validation, and there is no write path to validate.
- **`registry.ts` is ported in structure and keeps `tier`, but drops the mode/enabled-list
  machinery** — it would have nothing to filter, since every tool is tier 1 and every endpoint is
  a read. A mode variable with nothing behind it advertises a control that does not exist. One
  five-line boot assertion replaces the subsystem.
- **`redact.ts` is not ported** (§12.1). See "Redaction, all of it" above.
- **No `UNKNOWN_OUTCOME` error code.** The sibling needs it because a lost response to a `PUT`
  may still have changed the world. Every request this client can make is a read, so a timeout
  genuinely does mean "it did not happen" and a retry is safe.
- **`npm run smoke` exits 0 when it refuses for want of a key.** The refusal is the expected
  outcome of running it today, and the banner says `SMOKE NOT RUN` unmissably. If you want a
  pipeline to fail on a missing key, gate the pipeline on the key rather than on this exit code.

---

## Related records

In the sibling repo `nitrado-ark-mcp`, **read-only from here** — nothing in that repo was
modified by this one:

- `docs/decisions/EXECUTIVE-BOARD-2026-08-16-curseforge-mods.md` — the board minutes (DEC-002)
  this repo executes. Its Chair's Rulings are binding.
- `docs/decisions/decision-log.md` — DEC-002, and DEC-001 for the scope split that §10 rests on.
- `docs/adr/ADR-001-write-path-enforcement.md` — the shape ADR-002 ports, and the source of the
  normalization rule, the boot-check reasoning, and the refuse-to-start reasoning.

The two servers stay independent. `nitrado-ark-mcp` answers *"these project ids are in
`active-mods`"*; this repo answers *"project X's newest file is v2.1"*. **The model holds both.
Neither server calls the other, and neither ever holds the other's credential.**

# ADR-002: The endpoint allow-list, and why a method check would be wrong here

## Status

**Proposed.** Not accepted. Acceptance is a separate reviewed act and nothing in this
document should be read as authorising code beyond the scaffold it specifies.

- **Date:** 2026-08-18
- **Repository of record:** `curseforge-ark-mcp` (this repo, created this session)
- **Executes:** DEC-002, recorded in the sibling repo `nitrado-ark-mcp` at
  `docs/decisions/decision-log.md`, source record
  `docs/decisions/EXECUTIVE-BOARD-2026-08-16-curseforge-mods.md`, action **A1**.
- **Author:** `office-architect`
- **Implementer:** `office-backend-engineer` (action A2), gated on this record.
- **Numbering:** ADR-002 continues the sibling repo's sequence deliberately. ADR-001
  (`nitrado-ark-mcp`, ACCEPTED 2026-08-17) is a different repo and a different transport;
  the shared sequence records that the two are one line of reasoning, not that they share
  a codebase. They share nothing at runtime — see §9.

**What holds acceptance open.** One thing, and it is not resolvable by argument:

> **No CurseForge API key exists.** The key is not self-service — it is granted by
> application to Overwolf, and it is non-transferable. Until it arrives, **every claim in
> this document about the shape of a CurseForge response is documentation-derived.** No
> authenticated call has been made from this repo. There is no live measurement anywhere in
> this ADR, and §14 is the register of exactly which claims are which.

---

## Context

### What this repo is for

DEC-002 approved a **separate, read-only** MCP server for CurseForge mod curation,
discovery, and update surveillance for ARK: Survival Ascended. It is a sibling repo, not a
subdirectory of `nitrado-ark-mcp`, because a subdirectory shares a `.env`, a `package.json`
and a test run — which reintroduces the coupling the ruling rejects.

The chair's framing on inheritance is the standing instruction for this document:

> **"The discipline is the template, the specific controls are not."**

This ADR ports the discipline. §12 records, with reasons, the specific controls it
deliberately does **not** port — and that section is load-bearing, not housekeeping.

### The evidence problem, stated before any design

The sibling repo's culture is one property above all others: **observed fact and assumption
are never written in the same voice.** Its README carries a *"Verified against the live
account"* section and a *"Still unverified"* section, and the distinction is enforced by
where a claim is allowed to appear.

This repo starts with an empty *"Verified"* column. That is not modesty. It is the actual
state:

- No key exists, so no authenticated request has been made.
- `GET /v1/games` returns *"all games that are available to the provided API key"*
  (documented). So even the ARK: Survival Ascended `gameId` — the single most basic fact
  this server needs — **cannot be discovered before the key exists.**
- The sibling repo has already paid for the difference. Commit `5481c04` in its history
  corrected **three field paths that were wrong until checked against live responses.**
  Fixtures built from a published schema are a hypothesis with good handwriting.

Therefore: **ship as v0**, and the word *"verified"* is reserved. §13 makes that a rule with
a mechanism rather than an intention.

### Where the join with the Nitrado server happens

Recorded here because the boundary is an architectural constraint, not a preference — see
§9 and §10 for the provisions.

- `nitrado-ark-mcp` answers *"these project ids are in `active-mods`"*.
- `curseforge-ark-mcp` answers *"project X's newest file is v2.1, published six hours ago"*.
- **The model holds both.** Neither server calls the other. Neither server ever holds the
  other's credential.

---

## Decision

Thirteen provisions. They are numbered because tests, the README, the backend engineer's
scaffold, and any future review will refer to them by number.

---

### 1. THE CHOKEPOINT IS AN ENDPOINT ALLOW-LIST, NOT A METHOD CHECK

This is the central provision. Everything else in this ADR is supporting work.

#### 1.1 The finding: CurseForge uses POST to READ

CurseForge's catalog API uses `POST` for **bulk retrieval**. These endpoints take a request
body carrying a list of ids and return the corresponding records. They read. They mutate
nothing:

| Endpoint | What it does |
| --- | --- |
| `POST /v1/mods` | Returns the mods for a list of mod ids |
| `POST /v1/mods/files` | Returns the files for a list of file ids |
| `POST /v1/mods/featured` | Returns featured/popular/recently-updated mods for a game |
| `POST /v1/fingerprints` | Returns mod-file matches for a list of file fingerprints |
| `POST /v1/fingerprints/fuzzy` | Returns fuzzy fingerprint matches |

Across the whole documented catalog API — Games, Categories, Mods, Files, Fingerprints,
Minecraft — **every documented endpoint is a `GET` or one of these read `POST`s. There is
no documented `PUT`, `PATCH` or `DELETE`, and no `POST` that changes anything.**

> **Scope of that sentence, stated precisely because the ADR leans on it.** It is a
> statement about *the catalog API documented at `docs.curseforge.com/rest-api`, on host
> `api.curseforge.com`*. It is **not** a claim that CurseForge operates no mutating HTTP
> surface anywhere. It does — see §14.2, which records a documented upload API on a
> different host with a different auth header, found while checking this ADR's premises
> against primary source. That finding does not weaken this provision. **It is the strongest
> argument for it**, and §1.5 says why.

#### 1.2 Why the sibling's chokepoint would be WRONG here

`nitrado-ark-mcp` enforces read-only at the transport with, in effect,
`method !== "GET" → refuse`. Copying that here fails in the most expensive possible way:
**it works.** It refuses things, it passes its own tests, and it silently makes the server
bad at its job.

`method !== "GET"` blocks `POST /v1/mods` and `POST /v1/mods/files` — the two batch reads
that make dependency resolution efficient. Without them, `resolve_mod_dependencies` walks a
dependency tree **one `GET` per node**, which is the pathological case: the deeper and
wider the tree, the worse it gets, against a paginated third-party API with an unknown rate
limit. The control would be paying its full cost while protecting against nothing, because
there is nothing on this API for it to protect against.

#### 1.3 Why the obvious fix is worse than the bug

A future maintainer hits that wall, reads the CurseForge docs, correctly concludes the
POSTs are reads, and relaxes the check to allow `POST`. **That relaxation deletes the
guarantee entirely**, and it does so silently.

The arithmetic is the whole point:

```
allowed = { GET }                    → the batch reads are refused (broken, loudly)
allowed = { GET, POST }              → every request this client can construct is allowed
```

The documented catalog API contains only `GET` and `POST`. A gate admitting both admits
everything. The tests still pass — they were written against a gate that refuses `DELETE`,
and it still refuses `DELETE`, and no tool has ever issued one. **The control becomes
vacuous while continuing to look present**, which is precisely the failure ADR-001 exists to
correct in the sibling repo: a chokepoint that is a *mode gate* rather than a *capability
gate*, whose safety property is held up by the absence of code rather than the presence of
a control.

This repo gets to build it correctly the first time. That is the only reason the sequencing
of DEC-002 makes sense.

#### 1.4 The provision

**Every outbound request must match an explicit entry in a closed allow-list of
`{ method, path-pattern }` pairs. An unmatched request is REFUSED before the request is
built.** Not logged and sent. Not warned about. Refused, in the transport, in the one
function that attaches the API key.

The failure mode is **"unmatched request refused"**, never **"unrecognised request sent"**.

**Adding an entry is the reviewable act.** The allow-list is the security property of this
repo, and it is a diff a human reads. A new capability is a new line in one file, next to
six others, in a review that has to answer *"is this endpoint a read?"* — which is a
question a reviewer can actually answer. Compare the method check, where the equivalent
change is a one-character edit to a set literal whose consequence is invisible.

#### 1.5 What the allow-list buys that a method check cannot

The upload API found in §14.2 is the argument. It is a `POST` that mutates, on host
a host that is **not** `api.curseforge.com`, authenticated with `X-Api-Token`. (The exact
upload hostname is deliberately not asserted here — it was not confirmed, and §1.6's pin is
an allow of one host, not a deny of a named other.)

- Under `allowed = { GET, POST }`, nothing about that request's **method** is
  distinguishable from `POST /v1/mods`. The gate is blind to the difference.
- Under the allow-list, that request has **no entry**. It is refused on the path — and the
  host pin in §1.6 refuses it a second time, for an independent reason.

The read-only property of this server is therefore **a property of the client's allow-list,
not an inherited property of the vendor's API surface.** That distinction matters, because
vendor surfaces grow and this repo will not be re-audited when they do.

#### 1.6 The exact allow-list

Seven entries. This is the complete set for v1.

| # | Method | Path pattern | Serves | Shape |
| --- | --- | --- | --- | --- |
| **E1** | `GET` | `/v1/games` | capability detection (§5), `get_api_diagnostics` | paginated |
| **E2** | `GET` | `/v1/mods/search` | `search_mods` | paginated |
| **E3** | `GET` | `/v1/mods/{modId}` | `get_mod`, `get_latest_file` | single record |
| **E4** | `GET` | `/v1/mods/{modId}/files` | `list_mod_files`, `get_latest_file` | paginated |
| **E5** | `GET` | `/v1/mods/{modId}/files/{fileId}` | `get_mod_file` | single record |
| **E6** | `POST` | `/v1/mods` | `resolve_mod_dependencies` | bulk read, body = mod ids |
| **E7** | `POST` | `/v1/mods/files` | `resolve_mod_dependencies` | bulk read, body = file ids |

Six mechanical requirements, because a pattern-matching control is only as good as the
string it matches. Five of these are ported from ADR-001 §1; the ordering hazard in the
third is specific to this API.

- **Matched on `{method, path}` jointly.** E3's `GET /v1/mods/{modId}` does not authorise
  `DELETE /v1/mods/123`. E6's `POST /v1/mods` does not authorise `POST /v1/mods/123`.
- **The host is pinned.** The base URL is `https://api.curseforge.com` and the allow-list
  match includes it. A request to any other host is refused at the transport, regardless of
  path. This is what makes §1.5's second refusal real rather than rhetorical.
- **Id segments bind to `[0-9]+`.** Not `[^/]+`. This is not cosmetic: `/v1/mods/search`
  and `/v1/mods/{modId}` are siblings, and a permissive `{modId}` makes E3 match
  `/v1/mods/search`, `/v1/mods/anything`, and — with a lax separator — a good deal more.
  **Numeric-only id segments make the E2/E3 ambiguity structurally impossible** rather than
  dependent on match ordering. Match ordering must additionally be deterministic (first
  match wins, entries in the order above), so that a future entry cannot shadow an existing
  one by accident.
- **One normalization, before the check, and the URL is built from the normalized string.**
  Percent-decode exactly once; **refuse any `%` that survives that decode**; fold
  backslashes (this runs on Windows); refuse `.`, `..` and empty path segments. This rule is
  ported verbatim in effect from ADR-001 §1 as amended — the amendment exists because the
  original was insufficient, and `%252e%252e` is the case that broke it. Do not re-derive
  it; do not weaken it on the grounds that this transport only reads.
- **Only E6 and E7 may carry a body.** A body on any `GET` entry is a programming error and
  is refused, not dropped. E6 and E7 bodies are shape-checked before dispatch: an object
  with exactly the expected id-array key, elements all non-negative integers, array
  non-empty, and length within the cap in §4.4.
- **Query parameters do not participate in the match, and are validated separately.** §4
  owns pagination bounds. The allow-list decides *which endpoint*; §4 decides *whether the
  arguments are legal*. Two questions, two controls, two failure messages.

#### 1.7 Documented endpoints deliberately NOT on the list

Recorded because an allow-list's exclusions are as much a decision as its entries, and
because a future reader needs to know an omission was a choice:

| Endpoint | Why excluded |
| --- | --- |
| `GET /v1/mods/{modId}/files/{fileId}/download-url` | **Refused outright** by DEC-002 §11.3 — no download or install tool. Nitrado installs mods itself. |
| `GET`/`POST` `/v1/fingerprints`, `/v1/fingerprints/fuzzy` | Deferred by DEC-002 §11.2. Fingerprinting needs local mod files this server never sees. |
| `POST /v1/mods/featured` | Deferred. A read `POST`, and still not on the list — the list is scoped to what v1's seven tools need. |
| `GET /v1/categories` | Deferred by DEC-002 §11.2 (categories / class taxonomy). |
| `GET /v1/games/{gameId}`, `/v1/games/{gameId}/versions`, `/v1/games/{gameId}/version-types` | Not needed; E1 is sufficient for §5. |
| `GET /v1/mods/{modId}/description`, `.../changelog` | Not needed by v1's seven tools. Free-text HTML; see §12.3. |
| `/v1/minecraft/*` | Wrong game. |

#### 1.8 Testability — the hard requirement

**The allow-list must be fully testable against an injected fake `fetch`, with no API key
and no network.** This is not a nice-to-have; it is the only way any of §1 gets verified
before the key arrives, and it is the one part of this ADR that can reach "verified" today.

Required tests, at minimum:

1. Each of E1–E7 **is** dispatched (the preimage — see below).
2. `DELETE /v1/mods/123` is refused **before** `fetch` is called. Assert on the fake's call
   count, not on the thrown error alone.
3. `POST /v1/mods/123` is refused — right path family, wrong method pairing.
4. `POST /v1/mods/search` is refused — right path, wrong method.
5. `GET /v1/mods/{modId}/files/{fileId}/download-url` is refused — a *read* `GET` on the
   documented API, refused because it is not on the list. **This is the test that proves the
   control is an allow-list and not a method check**, and it is the one to write first.
6. A request to any host other than `api.curseforge.com` — including an otherwise
   well-formed `/v1/mods/search` — is refused on the host pin.
7. `GET /v1/mods/../games` and `/v1/mods/%252e%252e/games` are refused by normalization.
8. A `GET` entry called with a body is refused.
9. E6 with a body of `{modIds: ["1; DROP"]}`, an empty array, or an over-cap array is
   refused by shape-check.

**Preimage discipline, ported from the sibling repo's test suite and non-negotiable:** a
test that proves a request was refused must first prove the request would otherwise have
been sent. Test 1 is what makes tests 2–9 non-vacuous. A refusal suite over a client that
can dispatch nothing passes perfectly and proves nothing.

---

### 2. Auth: `x-api-key`, and refuse to start without it

**The API key is sent in an `x-api-key` request header.** Documented. This is **not** the
`Authorization: Bearer` scheme the sibling repo uses for Nitrado — do not copy that code
path, and do not "support both".

- **Refuse to start without a key.** Ported from ADR-001's reasoning verbatim, because it
  applies unchanged: *a stdio MCP server that starts cleanly and then throws on all seven
  tools is a miserable thing to debug.* The startup error must name **both locations
  checked** (the environment variable and the `.env` file), the exact variable name, and the
  fact that the key is obtained by application to Overwolf and is not self-service.
- **The key is attached in exactly one place** — the same function that enforces §1. One
  place to attach the credential, one place a request can be refused.
- **Never echo the key.** See §12.1 for the full extent of the redaction this repo gets, and
  the reasoning for why it is one function and not a module.
- **No key value, token, or fragment thereof appears in any committed file.** `.env` is
  gitignored; `.env.example` carries the variable name and an empty value.
- **The key is non-transferable** under Overwolf's terms. That is a compliance fact with an
  architectural consequence: it forecloses any design in which this server's credential is
  passed to, proxied for, or shared with another process. §9 forbids the specific case.

---

### 3. The response envelope

Documented shape: **`{ data, pagination }`**, where `pagination` carries `index`,
`pageSize`, `resultCount`, `totalCount`.

Decisions, all of which are about not manufacturing confidence:

- **The client unwraps `data` in one place** — the same transport function, after the
  status check, before anything tool-shaped sees the response. Tools receive `data` plus, on
  paginated endpoints, a normalized page descriptor. No tool reaches into `.data` itself; a
  second unwrap site is a second envelope contract.
- **`data` absent is an ERROR, not empty.** If the parsed body has no `data` key, the
  upstream shape is not what this client was written for and the correct answer is a loud
  upstream-shape error naming the endpoint. Coercing a missing `data` to `[]` converts a
  broken integration into "no results found", which is a confident wrong answer — the exact
  defect class the sibling repo's test suite exists to catch.
- **`pagination` absent on a single-record endpoint is normal** (E3, E5). Do not synthesise
  one.
- **`pagination` absent on a paginated endpoint is an ERROR** (E1, E2, E4). Do not assume
  "one page". Assuming one page is how a tool reports 50 of 900 mods as if it were all of
  them. If this turns out to be how CurseForge actually behaves, it becomes a documented
  quirk with a live observation behind it — not a silently absorbed default.
- **The page descriptor is surfaced to the model, not consumed by the client.** Every
  paginated tool's output states `index`, `pageSize`, `resultCount`, `totalCount`, and an
  explicit boolean for whether more results exist. The model cannot reason about
  completeness it was never told about.

---

### 4. Pagination bounds — documented AND enforced client-side

Verified against the live documentation, quoted:

> *"The maximum page size is 50 results per page and capped at 10000 total results. Note:
> The limit is (index + pageSize <= 10,000)."*

Both numbers confirmed on primary source: **max `pageSize` is 50**, and the constraint is
**`index + pageSize <= 10000`**.

- **4.1 — `pageSize > 50` is REFUSED, not clamped.** Naming the bound. Clamping is the wrong
  choice here for a reason worth recording: a model that asks for 200 and silently receives
  50 has no way to know it received a page instead of a set, and will reason about the
  result as if it were complete. A refusal that says "max is 50, you asked for 200" produces
  a correct second call. A clamp produces a wrong conclusion.
- **4.2 — `index + pageSize > 10000` is REFUSED** before dispatch, with the ceiling named
  and the largest legal `pageSize` for that `index` stated in the message.
- **4.3 — When `totalCount > 10000`, the tool must say the tail is unreachable.** In those
  words. A result set larger than the API's own addressable window is a fact about the API,
  and hiding it produces a search the model believes it exhausted. Advise narrowing the
  filter rather than paging.
- **4.4 — Bulk-read bodies are capped client-side.** `POST /v1/mods` and `POST /v1/mods/files`
  take id arrays. **Whether CurseForge caps their length is UNVERIFIED** — no such cap is
  documented and none has been observed. This repo therefore imposes its own: **200 ids per
  request**, chunked above that, with the cap named in one constant and a comment stating it
  is ours and not the vendor's. An unbounded body against an API with an unknown rate limit
  is a self-inflicted incident.
- **4.5 — All four bounds are tested with no key and no network.** They are argument
  validation; they run before `fetch`. Same preimage discipline as §1.8.

---

### 5. Capability detection over assumption: do not hardcode `gameId`

Ported from the sibling repo, where the equivalent rule is that the ARK Nitrado game slug is
read live even though it is known to be `arksa`.

- **The ARK: Survival Ascended `gameId` is NOT hardcoded.** It is discovered at runtime via
  `GET /v1/games` (E1), matching on the game's slug/name, and **cached for the process
  lifetime only**.
- **If it cannot be resolved, fail loudly**, naming what was searched for and how many games
  the key returned. Do not fall back to a guessed integer. A wrong `gameId` on
  `GET /v1/mods/search` does not error — `gameId` is a required filter, so a wrong one
  returns a clean, empty, entirely wrong result set. That is the worst available failure
  mode and a hardcoded constant is how you get it.
- **This cannot be checked before the key exists.** Documented: `GET /v1/games` returns
  *"all games that are available to the provided API key"*, and *"a private game is only
  accessible by its respective API key."* So both the ASA `gameId` **and whether ASA is
  visible to this key at all** are unresolvable today. Record both in the README's
  unverified table (§13). If ASA turns out not to be visible to the granted key, that is a
  v1-blocking discovery and it belongs back at the board, not worked around in code.

---

### 6. Empty is not unknown

Ported. Three states, never conflated, each with a distinct representation:

| State | Meaning | Representation |
| --- | --- | --- |
| **Empty** | The API answered, and the answer is "none" | `[]` / `0`, with the query echoed so the model can see what returned nothing |
| **Absent** | The field was not in the response | `null` — **never** `0`, `""` or `[]` |
| **Unknown** | The request did not complete, or the shape was wrong | An error naming the endpoint and the reason. Never a value. |

Concretely, for this API: `data: []` from `search_mods` means no mods matched — a real
answer. `latestFiles: []` on a mod means the mod has no published files — also a real
answer, and materially different from `get_latest_file` having failed. A mod field that is
missing from the response is `null`, and `null` must not be rendered to the model as a
zero or an empty string.

---

### 7. The v1 tool surface: exactly seven tools, all tier 1

Fixed by DEC-002 §11.1. Not expandable without a new board record.

| Tool | Endpoint(s) | Kind | Notes |
| --- | --- | --- | --- |
| `search_mods` | E2 `GET /v1/mods/search` | single-record GET, paginated | `gameId` from §5, never a parameter. §4 bounds apply. |
| `get_mod` | E3 `GET /v1/mods/{modId}` | single-record GET | |
| `list_mod_files` | E4 `GET /v1/mods/{modId}/files` | GET, paginated | §4 bounds apply. |
| `get_mod_file` | E5 `GET /v1/mods/{modId}/files/{fileId}` | single-record GET | |
| `get_latest_file` | E3, and E4 when needed | single-record GET(s) | **The surveillance primitive.** See §7.1. |
| `resolve_mod_dependencies` | **E6/E7 bulk POSTs** | bulk read | See §7.2. |
| `get_api_diagnostics` | E1 `GET /v1/games` | single-record GET | See §7.3. |

**All seven are tier 1.** The `tier` field on `ToolDef` is ported (DEC-002 §9.1) — and see
§11 for the one assertion that makes the field mean something without porting the sibling's
tier-2/3 machinery.

#### 7.1 `get_latest_file` — the surveillance primitive

This is the tool the whole repo exists for: *"is there a newer version of project X than the
one my server is running?"*

It reads `latestFiles` / `latestFilesIndexes` from the mod record (E3), and falls back to
E4 when the mod record does not carry a usable candidate. Two design constraints:

- **"Latest" must be defined in the tool's own output, not assumed.** *Latest by
  `fileDate`? Latest matching a game version? Latest with `releaseType` = release rather
  than alpha?* These give different answers, and a mod-update decision made on the wrong one
  is exactly the "confident wrong answer" class. The tool states which ordering it used and
  what it filtered on, every time.
- **`releaseType` and `sortableGameVersions` are documentation-derived field paths**, and
  the numeric meaning of `releaseType` is unverified (§14.3). The tool must degrade honestly
  — if it cannot determine release type, it says so and returns the candidate rather than
  silently treating alpha as release.

#### 7.2 `resolve_mod_dependencies` — why the batch endpoints matter

The only tool that uses `POST`, and the reason §1 is written the way it is.

Algorithm, breadth-first, batched at every level:

1. Fetch the seed mod(s) — **`POST /v1/mods`** (E6) with the id list. One request, not N.
2. From each mod's files, collect `dependencies[]` — documented as `FileDependency`
   objects carrying `modId` and `relationType`.
3. Collect the next level's unique `modId`s, subtract everything already seen, and fetch the
   whole level with **one** `POST /v1/mods` (E6). Use `POST /v1/mods/files` (E7) when
   specific file records are needed rather than mod records.
4. Repeat to a **bounded depth** with a **visited set**. Both are mandatory: a dependency
   graph from a third party may contain a cycle, and an unbounded traversal is a
   self-inflicted rate-limit incident. Depth cap and node cap are named constants; when a
   cap is hit the tool reports the tree as **truncated**, in that word, with the frontier
   listed.
5. Chunk any level exceeding the §4.4 cap.

**One `POST` per level, not one `GET` per node.** That is the entire efficiency argument,
and it is why a method check would have been a functional defect and not merely
over-strict.

**`relationType` filtering is BLOCKED on an open question (§14.3).** The numeric enum's
meaning could not be established from primary source, and required-vs-optional-vs-tool
determines whether an edge is followed at all. Until it is resolved: traverse **all** edges,
and **surface the raw `relationType` integer unmapped** rather than guessing a label. A
wrong label here produces a dependency list that is wrong in a way nobody will check.

#### 7.3 `get_api_diagnostics`

Ported in purpose from the sibling repo, and it is the honest-status tool. It must report:

- `buildinfo` — commit and dirty flag (§13.3).
- Whether a key is configured. **Never the key, nor a prefix, nor a length.**
- The resolved ASA `gameId` and how it was resolved, or the failure (§5).
- **The version posture: `v0`, and that field paths are unverified** (§13). This tool is
  where a caller finds out it is talking to an unverified client, so it says so rather than
  implying health.
- Rate-limit observations, if the API returns any headers. **CurseForge's rate limit is
  undocumented** — report what was observed, or `null`. Never a guess, and never `0`.

---

### 8. `resolve_mod_dependencies` is the only tool that may issue a `POST`

Stated as its own provision because it is a structural claim a test can assert: exactly two
allow-list entries carry `POST`, and exactly one tool is permitted to reach them. A future
tool wanting a bulk read is a review, not a convenience.

---

### 9. NEITHER SERVER CALLS THE OTHER. THE AGENT CORRELATES.

Carried forward from DEC-002 Ruling 4, binding, and recorded here rather than only in the
minutes because minutes are not read during implementation.

- `nitrado-ark-mcp` answers *"these project ids are in `active-mods`"*.
- `curseforge-ark-mcp` answers *"project X's newest file is v2.1"*.
- **The model holds both. Neither server ever holds the other's credential.**

**EXPLICITLY REFUSED:** a `check_for_mod_updates` tool inside `nitrado-ark-mcp` that reaches
out to CurseForge. The chair's words: *that is precisely the RCON shape.*

**The mirror refusal, binding on this repo:** `curseforge-ark-mcp` makes **no Nitrado call,
holds no Nitrado token, and reads no Nitrado config.** The host pin in §1.6 enforces the
first mechanically. There is no `NITRADO_*` variable in this repo's config surface, and its
absence is the point — a credential that is not read cannot be leaked, logged, or blast-
radiused.

The reasoning, since a future reader will find the correlation-in-the-model step clumsy and
want to "just wire them together": two credentials in one process means one `.env`, one
revocation story for two revocation authorities, and one compromise reaching both. The
Nitrado token is documented as equivalent to full control of the game server. The
CurseForge key is non-transferable under Overwolf's terms. Joining them in a process
inherits the worse half of each.

---

### 10. NO AUTONOMOUS UPDATE-THEN-DEPLOY LOOP. NOT NOW, NOT LATER.

Carried forward from DEC-002 Ruling 4 and §11.3, with its reasoning, because the board
required the refusal to live in **this ADR** and not only in the minutes.

**REFUSED: an agent that wakes on a timer, reads mod versions, decides, and writes
`active-mods`.**

- **Surveillance means the agent may OBSERVE a new version. It does not get to act.**
- The chair's assessment, recorded because it is a prediction about how this rule will be
  broken: **mod auto-update is the most seductive re-entry point for scope (D).** It looks
  like automation, it is genuinely useful, and every step of it is individually reasonable.
- The structural reason it stays refused is the sibling repo's scope-(D) split. A
  deterministic cron task executed by Nitrado's own scheduler is approved there because
  **no agent process exists at fire time and there is no injection surface at fire time.**
  A loop that reads mod versions and decides inverts both: a model is live at decision time,
  and its inputs are whatever a third-party catalog happened to return. That is not an
  interface change to something the founder can already do by hand. It is a new capability.
- **The deployment half is queued regardless.** Writing `active-mods` is a Nitrado settings
  write, tier 2, in the *other* repo, gated on ADR-001 acceptance plus its verification
  sprint (DEC-002 action A6, marked DO NOT START). **Mods do not jump the write-path queue.**

**Consequence for this repo, concretely:** no scheduler, no timer, no long-lived polling
loop, no background task, and no persisted "last seen version" state. `get_latest_file` is
called by a model in a conversation, and answers. If a future need genuinely requires
scheduled surveillance, it needs its own board record superseding DEC-002 Ruling 4 — not an
extension of this one.

---

### 11. Mod AUTHORING is refused outright — no MCP work, now or later

Carried forward from DEC-002 Ruling 2, binding, recorded so nobody revisits it.

The chair's reasoning: the ARK Dev Kit is a **UE5 GUI**, the upload path is a **widget
inside the editor**, and **CurseForge cloud-cooks from there**. Anything built here would
wrap *"open the editor"* — which the chair called **"a lie with a tool schema on it."** That
sentence is the durable part: a tool whose implementation is an instruction to a human is
worse than no tool, because the model will present it as a capability.

**One correction to the record, filed rather than glossed** — see §14.2. The minutes state
*"No REST surface exists."* Checked against primary source, that premise is broader than the
evidence supports: CurseForge documents an **upload API** (`POST .../projects/{id}/upload-file`,
`X-Api-Token`) for project authors. **The refusal is unaffected and remains binding**, because
it does not rest on that premise — it rests on the ARK-specific cook-and-upload path, and
whether that upload API is even available for ARK: Survival Ascended is unverified. But the
sentence *"no REST surface exists"* should not be repeated as a fact, and this ADR does not
repeat it. Whether the minutes are amended is the board's call, not this ADR's.

**Structural enforcement instead of a promise.** DEC-002 §9.2 says do not port the sibling's
tier-2/3 gating logic "beyond the type". So:

- `ToolDef.tier` is ported (§7).
- **A boot assertion refuses to start the process if any registered tool declares a tier
  other than 1.** It reads no environment variable — ported from ADR-001 §2's reasoning that
  *two controls that fail for the same reason are one control*, so this one must not consult
  config.
- The effect: adding a mutating tool to this repo is not a code change that works. It is a
  process that will not start, which forces the conversation to happen at the ADR level
  where it belongs. One assertion, roughly five lines, replacing a subsystem.

---

### 12. Right-sizing the ceremony — what this repo deliberately does NOT port

**This is the most likely provision to be "improved" by someone diligent, so its reasoning is
recorded first, in the chair's terms:**

> **Performing the same ceremony for a much smaller risk teaches future readers to discount
> the ceremony everywhere.**

That is the load-bearing sentence in this section. A repo that runs a 224-line redaction
module and a token-leak runbook to protect **public catalog data** has not become safer; it
has taught its next reader that this project's security apparatus is decoration. When that
reader later meets a control that genuinely matters — §1, or ADR-001's mutation allow-list
next door — they will discount it by the same reflex. **Over-applied ceremony is not a
neutral cost. It actively degrades the controls that are real.**

The corollary is the honest one and must be stated too: this reasoning is only valid if the
risk assessment behind it is correct. It is written down here so it can be checked, and it
rests on one claim — **CurseForge catalog data is public by construction.** Mod names, file
versions, and dependency graphs are visible on the public website without authentication.
If that claim is ever false for some class of data this repo touches (a private game
visible only to this key, say — §5 notes such things exist), this section is void for that
data and needs revisiting.

#### 12.1 DO NOT PORT: `redact.ts` in anything like its current form

The sibling repo's `redact.ts` is 224 lines of allow-list-based response filtering, and it
earns every line: it protects a **server connect address** and, per that repo's own findings,
a gameserver response that carries **plaintext credentials including an admin password**.

None of that exists here. Every byte this server receives is public catalog data.

**What this repo keeps — the whole of it:** *never echo the API key.* One function. Applied
to error messages and any upstream body snippet before it can enter the model's context. The
sibling repo has an open advisory about exactly this direction — upstream response bodies
carrying secrets into the model's context — and the proportionate answer here is:

- **Request headers are never included in errors.** Not the key, not a redacted key, not a
  header-name list. Errors name method, path, and status.
- **Body snippets from upstream errors are permitted** (public data), bounded in length, and
  passed through the key scrub as belt-and-braces.
- The scrub has one test: a synthetic key-shaped string in an error path does not survive
  into the rendered message. **Synthetic, per the sibling repo's fixture discipline — never a
  real key, in a test or anywhere else.**

#### 12.2 DO NOT PORT: the scope matrix and the token-leak runbook at that weight

The sibling repo's scope matrix and token-leak runbook exist because that token is
documented as equivalent to full control of a game server, and a leak is an incident with
world-destroying reach.

A leaked CurseForge key grants **read access to a public catalog**, plus quota consumption
against the founder's key. That is real, and it is not the same category.

Right-sized, this repo gets:

- **One paragraph in the README**: what the key is, that it is non-transferable and obtained
  by application to Overwolf, that a leak means revoke-and-reapply — and that reapplication
  is a **queue, not a self-service reset**, which is the one genuinely awkward property of
  this credential and the only reason the paragraph exists at all.
- **No scope matrix.** CurseForge publishes no read-only scope and no scope selection; there
  is nothing to matrix. Note the absence — a reader who goes looking for scopes should find
  out they do not exist rather than conclude nobody checked.
- **No runbook document.**

#### 12.3 DO NOT PORT: the free-text control-loop restriction, as a *control*

ADR-001 §8 restricts a control loop's inputs to structured non-free-text fields. It cannot
be ported as a control here for a simple reason: **§10 forbids the control loop entirely,**
so there is nothing to restrict.

The *hazard* is still worth naming, because it explains an exclusion in §1.7. Mod
descriptions and changelogs are **attacker-authorable free text** — a third party writes
them, and they arrive in a model's context. `GET /v1/mods/{modId}/description` and the
changelog endpoint are off the allow-list, and this is the second reason why. Should a
future ADR add them, that ADR owns the untrusted-text question, and it should say so in its
own §1 rather than discover it in review.

---

### 13. Ship as v0. The word "verified" is gated.

DEC-002 §10, hard constraint: **every field path in every fixture is a HYPOTHESIS until the
key arrives.** This is not hypothetical caution. Commit `5481c04` in the sibling repo
corrected **three field paths that were wrong until checked against live responses**, in a
repo whose fixtures were built the same careful way these will be.

- **13.1 — Version is `0.x`.** Not `1.0.0`. The version number is a claim about verification
  status, and `1.0.0` on a client whose every field path is unconfirmed is a false one.
- **13.2 — The README carries an explicit unverified-claims table** (DEC-002 action A3,
  `office-technical-writer`), in the sibling repo's own *"Still unverified"* idiom. It must
  carry, at minimum, every row of §14.3 below. The README must **not** contain a *"Verified
  against the live account"* section — an empty one invites filling, and its absence is
  itself accurate.
- **13.3 — `buildinfo` is ported**: generated, gitignored, stamped with commit and dirty
  flag, surfaced by `get_api_diagnostics`. The sibling repo's reasoning applies unchanged —
  a `dist/` built from uncommitted local edits cannot answer "which code produced that
  answer?"
- **13.4 — `npm run smoke` exists and refuses cleanly without a key**, naming what it would
  have probed. It is the artifact that turns key-arrival into a single command rather than a
  research task, and DEC-002 §10 lists it as buildable now.
- **13.5 — The smoke probe's job is to falsify §14.3, one row at a time.** Its output is the
  input to a follow-up ADR or amendment. **Amend in place, dated and attributed, rather than
  leaving a reader to reconcile two versions** — this is how ADR-001 handled its own sprint
  corrections, and it is the house style.

---

## Alternatives considered

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Copy the sibling's `method !== "GET"` chokepoint** | Zero design work. Proven code next door. Passes its own tests immediately. | Refuses the two batch reads that make `resolve_mod_dependencies` viable, forcing one `GET` per dependency node. Pays a control's full cost against a threat this API does not present. | **Rejected — §1.2** |
| **Method check, relaxed to allow `POST`** | Fixes the above with a one-character edit. Tests still pass. | The documented API contains only `GET` and `POST`, so the gate admits every constructible request. **Deletes the guarantee while continuing to look present.** The most dangerous option on this table, because it is the one a future maintainer arrives at unaided. | **Rejected — §1.3** |
| **Per-tool checks instead of a transport check** | Local, readable, no shared abstraction. | The sibling README's argument holds verbatim: *a per-tool check is a rule a future tool can forget; a transport check is one it cannot route around without deleting it.* | Rejected |
| **No chokepoint — it is a read-only API, so there is nothing to enforce** | Least code. Defensible on today's vendor surface. | Makes the safety property an inherited fact about a third party rather than a property of this code. §14.2 already found a mutating CurseForge surface on another host. And it repeats ADR-001's original defect exactly: a guarantee held up by the absence of code. | **Rejected** |
| **A deny-list of known-mutating endpoints** | Nothing to maintain while the vendor adds only reads. | Deny-lists rot, and the sibling repo already wrote down why: on the day the vendor ships a mutating endpoint, a deny-list ships it too and nobody notices. Wrong direction for a control whose failure should be refusal. | Rejected |
| **One server, two clients (extend `nitrado-ark-mcp`)** | One repo, one install, one config. The founder's own argument that a read-only client has no mutating surface was judged **correct on its own terms.** | Three other harms stand: timing against ADR-001's live surgery, degradation of the README's single-transport claim into two differently-defined transports, and credential blast radius across two revocation authorities. | **Rejected — DEC-002 Ruling 1** |
| **Allow-list + host pin + numeric id segments + boot tier assertion** (this ADR) | Failure mode is refusal. Adding a capability is a reviewable one-line diff. Fully testable with no key and no network. Batch reads work because they are named, not because a class of methods was waved through. | Seven entries to maintain. A new endpoint is a two-file change. Deliberately slower to extend. | **Adopted** |

---

## Consequences

### Positive

- The read-only property is a property of **this repo's allow-list**, not of CurseForge's
  current endpoint inventory. It survives the vendor adding a mutating endpoint.
- The batch reads work, so `resolve_mod_dependencies` costs one request per dependency level
  instead of one per node — the capability the method check would have quietly destroyed.
- The most likely future mistake (relax the method check) is not available: there is no
  method check to relax, and the equivalent act is adding a named endpoint in a review.
- Most of v1 is verifiable **today**, with no key: §1's refusals, §3's envelope handling,
  §4's bounds, §6's three states. All against an injected fake `fetch`.
- Tier stays meaningful for five lines of assertion instead of a subsystem, and adding a
  mutating tool is a process that will not start rather than a diff that works.
- The two servers stay independent, so a compromise of either credential reaches exactly one
  service.

### Negative — the honest cost

- **Every new capability costs an allow-list entry.** A contributor adding a tool hits this
  before shipping anything. Intended, and still annoying.
- **A closed allow-list will refuse something legitimate at some point**, and the error will
  look like a bug to whoever hits it. It must name the file to edit and the entry shape.
- **`resolve_mod_dependencies` cannot filter by dependency type until §14.3 is resolved.** It
  will over-collect — traversing optional and tool edges as if required — and say so. A wrong
  label would be worse than a wide net, but a wide net against an unknown rate limit is a
  real cost, not a free one.
- **Refusing rather than clamping `pageSize` means more round trips** when a caller guesses
  high. Accepted: a second correct call beats a first confident wrong answer.
- **§5 means the server cannot start doing useful work until `GET /v1/games` succeeds.** One
  extra request and one more failure mode at startup, in exchange for never running a search
  against a guessed `gameId` that returns clean, empty, wrong results.
- **This ADR ships with an empty "verified" column, and it will stay empty for as long as
  Overwolf's queue takes.** The unverified-claims table is not a formality; it is the
  accurate state of the artifact, and it will be uncomfortable to publish.
- **§12's right-sizing is a judgement that could be wrong.** If any data this repo touches
  turns out not to be public, §12 is void for that data. The claim it rests on is stated in
  §12 precisely so it can be falsified rather than assumed.

### Neutral / deferred

- Categories/class taxonomy, fingerprint matching, featured mods, and premium/paid handling
  are deferred per DEC-002 §11.2. Each is an allow-list entry plus a tool when it arrives.
- CFWidget / CurseUpdate as an unauthenticated fallback is investigated **only if the key
  application is refused** (DEC-002 §11.2). Neither becomes a first-class dependency.
- Whether the ASA `gameId` is even visible to the granted key is unknown (§5) and could
  block v1. That is a board question if it happens, not an implementation workaround.

---

## §14 — Evidence basis, and what contradicts what

*This section exists because the sibling repo's culture is the separation of observed from
assumed, and an ADR written against an API nobody here has called must make its evidence
basis explicit or it fails on that standard alone.*

### 14.1 Confirmed against primary source (the live documentation)

Checked against `https://docs.curseforge.com/rest-api/` on **2026-08-18**. **Documentation,
not measurement.** No authenticated call was made from this repo, by anyone, at any point.

| Claim | Status |
| --- | --- |
| Auth header is `x-api-key` | Confirmed in docs |
| Response envelope is `{ data, pagination }`; pagination carries `index`, `pageSize`, `resultCount`, `totalCount` | Confirmed in docs |
| Max `pageSize` is **50** | Confirmed, quoted verbatim in §4 |
| `index + pageSize <= 10000` | Confirmed, quoted verbatim in §4 |
| `POST /v1/mods`, `POST /v1/mods/files`, `POST /v1/mods/featured`, `POST /v1/fingerprints`, `POST /v1/fingerprints/fuzzy` are read/bulk-retrieval endpoints | Confirmed in docs |
| No documented `PUT`, `PATCH`, `DELETE`, or mutating `POST` in the catalog API | Confirmed by enumerating the documented endpoint list |
| `GET /v1/mods/search` requires `gameId` | Confirmed in docs |
| `GET /v1/games` returns only games available to the provided key; a private game is accessible only by its own key | Confirmed in docs, quoted in §5 |
| `sortOrder` is `asc` / `desc`; `sortField` is an integer 1–12 | Confirmed in docs |

### 14.2 Where the live docs went BEYOND the brief this ADR was written from

Two findings. Both were checked because the ADR's premises depended on them, and both are
recorded here rather than silently absorbed.

**(a) `GET` variants of the fingerprint endpoints also exist.** The brief named only
`POST /v1/fingerprints` and `POST /v1/fingerprints/fuzzy`. The docs list `GET` forms of both
as well. Immaterial to this ADR — all four are off the allow-list (§1.7) — but recorded so a
future reader does not treat the brief's list as complete.

**(b) A mutating CurseForge HTTP surface DOES exist, on a different host, with a different
auth header.** This is the material one. CurseForge documents an **Upload API**: a
`POST multipart/form-data` to `/api/projects/{projectId}/upload-file`, authenticated with
**`X-Api-Token`** (not `x-api-key`), carrying `metadata` and `file` fields.

Three consequences, in order of importance:

1. **§1's core claim is stated correctly and narrowly** — *the catalog API documented at
   `docs.curseforge.com/rest-api`, on host `api.curseforge.com`, has no mutating endpoint.*
   It is not, and this ADR does not say, that CurseForge has no mutating API anywhere.
2. **This strengthens §1 rather than weakening it.** A relaxed `{GET, POST}` method gate
   cannot distinguish that upload request from `POST /v1/mods`. The allow-list refuses it
   twice — no matching path entry, and a host that is not `api.curseforge.com`.
3. **It corrects a premise in the board minutes.** DEC-002's authoring refusal states *"No
   REST surface exists."* That sentence is broader than the evidence supports. **The refusal
   itself is unaffected and remains binding** (§11): it rests on the ARK-specific
   Dev-Kit-cooks-and-uploads path, and whether the upload API is available for ARK: Survival
   Ascended is **unverified**. Flagged for the board; not this ADR's to amend.

### 14.3 UNVERIFIED — the hypothesis register

**Every row is a HYPOTHESIS.** Field paths are read off published schemas, which is exactly
the artifact class that produced three wrong paths in the sibling repo. The README's
unverified-claims table (§13.2) must carry all of these.

| # | Claim | Basis | Why it matters |
| --- | --- | --- | --- |
| **U1** | The ASA `gameId` value | **Undiscoverable without the key** (§5) | A wrong value returns clean, empty, wrong search results |
| **U2** | Whether ASA is visible to the granted key at all | Undiscoverable without the key | Could block v1 entirely |
| **U3** | `Mod` fields: `id`, `gameId`, `name`, `slug`, `latestFiles`, `latestFilesIndexes`, `dateModified`, `links`, `categories`, `allowModDistribution` | Published schema | Every tool output |
| **U4** | `File` fields: `id`, `modId`, `displayName`, `fileName`, `fileDate`, `gameVersions`, `sortableGameVersions`, `dependencies`, `releaseType`, `isAvailable` | Published schema | `get_latest_file`, `list_mod_files` |
| **U5** | `FileDependency` = `{ modId, relationType }` | Published schema | `resolve_mod_dependencies` traversal |
| **U6** | **The `FileRelationType` numeric enum mapping** | **NOT RESOLVED.** Three attempts against the docs; the page shows `relationType` as a bare integer with no published value table. Do **not** take a mapping from memory, from a blog, or from this ADR. | Determines whether an edge is required, optional, a tool, or incompatible — i.e. whether it is followed at all. **§7.2 blocks on this.** |
| **U7** | The `FileReleaseType` numeric enum (release/beta/alpha) | Not resolved from the docs page. **Partial corroboration only:** the Upload API (§14.2) uses the *names* `alpha`, `beta`, `release` — which supports the set, **not** the numeric mapping in the read API. | `get_latest_file` filtering; treating alpha as release is a wrong update recommendation |
| **U8** | Whether `pagination` is present on every paginated endpoint | Documented shape; never observed | §3 errors rather than assuming one page |
| **U9** | Whether ASA mods actually populate `dependencies`, `sortableGameVersions`, `latestFilesIndexes` | Schema says they can; ASA-specific behaviour unknown | An always-empty field is a capability gap, not a bug — and §6 requires telling them apart |
| **U10** | Any id-count cap on `POST /v1/mods` / `POST /v1/mods/files` bodies | **Not documented.** §4.4's 200 is **ours**, not the vendor's | Chunking strategy |
| **U11** | CurseForge rate limits | **Undocumented.** No published figure found | §7.3 reports observed headers or `null`, never a guess |
| **U12** | Real pagination behaviour past `index` 0, and behaviour at the 10000 ceiling | Documented constraint only | §4.3's truncation disclosure |
| **U13** | Base URL `https://api.curseforge.com` | Documentation-derived | Host pin (§1.6) depends on it |

---

## Open questions the implementer will hit

Recorded so the backend engineer does not have to re-derive them, and so a reviewer knows
they were foreseen rather than missed.

1. **U6 is a hard block on dependency-type filtering.** Ship the traversal with the raw
   integer surfaced and unmapped, per §7.2. Do not invent a mapping to make the output look
   finished.
2. **`get_latest_file` needs a defined ordering, and the definition is a product decision.**
   Newest by `fileDate`, newest matching the server's game version, or newest with
   `releaseType` = release? The tool must state which it used (§7.1). If the founder's actual
   question is *"is my server behind?"*, the game-version filter is probably load-bearing and
   probably needs the version string — which this server does not have and must not fetch
   from Nitrado (§9). **Likely answer: it becomes a required tool parameter.** Confirm before
   building.
3. **Does `search_mods` need `classId`?** ASA may organise mods under a class/section that
   makes unclassed search noisy. `GET /v1/categories` is deferred (§1.7), so the answer is
   unknown until the key arrives. Do not add the entry pre-emptively.
4. **Fixture provenance.** Fixtures must be **synthetic in content, structural in shape** —
   derive the structure from the published schema, synthesise the values, and assert the
   fixture's preimage is non-empty so a test cannot pass vacuously. This is the sibling
   repo's amended rule and it is the reason its refusal tests mean anything.
5. **Where does the `gameId` cache live?** §5 says process lifetime. That makes the first
   tool call after startup slower and makes every test that touches a tool need the games
   fixture. Inject the resolver; do not reach for a module-level singleton.
6. **The `.env.example` / config surface must contain no `NITRADO_*` variable** (§9). Its
   absence is a control. Do not add one "for convenience".
7. **Node/TypeScript baseline and MCP SDK version are unconstrained by this ADR.** Match the
   sibling repo unless there is a reason not to — same reviewer, same idioms, lower cost of
   reading both. If you deviate, say so in the README.
8. **`registry.ts` is ported "verbatim" per DEC-002 §9.1.** It will not be verbatim, because
   its tier-2/3 filtering has nothing to filter here (§11). Port the structure and the
   `tier` field; drop the mode/enabled-list machinery; keep the boot assertion. Note the
   deviation where you make it.

---

## Implementation notes

Phases. Each is separately verifiable, and **phases 1–4 are fully verifiable with no API
key** — which is the entire reason the board judged v1 buildable now.

| Phase | Work | Owner | Exit criterion | Key needed |
| --- | --- | --- | --- | --- |
| **0** | This ADR reviewed and accepted. | `office-architect` → reviewer | Status flips to ACCEPTED, or amendments applied | No |
| **1** | Repo scaffold: `package.json`, `tsconfig`, `src/`, `tests/`, `.env.example`, `buildinfo` generator. | Backend | `npm test` runs; `buildinfo` stamps commit + dirty flag | No |
| **2** | `CurseForgeClient`: allow-list (§1), host pin, normalization, `x-api-key` attach, refuse-to-start (§2), envelope unwrap (§3), pagination bounds (§4). **No tool yet.** | Backend | **§1.8's nine tests pass, with the preimage test first.** Test 5 (`download-url` refused) is the acceptance test for "allow-list, not method check" | No |
| **3** | `gameId` capability detection (§5); three-state coercion (§6); boot tier assertion (§11); key scrub (§12.1). | Backend | Deliberate tier-2 registration prevents startup; unresolvable `gameId` fails loudly | No |
| **4** | The seven tools (§7), registry wiring, server entry, synthetic fixtures, field-path tests. | Backend | All seven registered tier 1; `resolve_mod_dependencies` proven to issue one `POST` per level against the fake `fetch` | No |
| **5** | README with the unverified-claims table (§13.2) — **all of §14.3**; the right-sized key paragraph (§12.2); `npm run smoke` refusing cleanly (§13.4). | `office-technical-writer` (DEC-002 A3) | README describes the server that exists, with an empty verified column and no "Verified" section | No |
| **6** | **Key arrives.** Run `npm run smoke`. Falsify §14.3 row by row. | Founder + backend | Every row of §14.3 resolved or explicitly still open. **This is where the word "verified" becomes available** | **Yes** |

Risks to the plan itself:

- **Phase 6 will invalidate provisions**, the way ADR-001's phase 0 invalidated three of its
  own. That is the ADR working, not failing. Amend in place, dated and attributed (§13.5).
- **Phase 2 ships a control with nothing behind it**, and there will be pressure to skip to
  phase 4. The boot assertion in phase 3 is what makes that skip fail loudly rather than
  quietly — the same role phase 2 plays in ADR-001.
- **U6 may not be resolvable even with a key** if no ASA mod in the catalog exercises every
  relation type. In that case §7.2's unmapped-integer behaviour is not a stopgap, it is the
  answer, and the README should say so.
- **The key application may be refused.** v0 ships regardless. CFWidget / CurseUpdate is
  investigated only then, and only as a fallback (DEC-002 §11.2).

---

## Related records

All in the sibling repo `nitrado-ark-mcp`, **read-only from here** — nothing in that repo was
modified by this ADR:

- `docs/decisions/EXECUTIVE-BOARD-2026-08-16-curseforge-mods.md` — the board minutes this
  ADR executes (action A1). **Its Chair's Rulings are binding on this document.**
- `docs/decisions/decision-log.md` — DEC-002, and DEC-001 for the scope-(D) split that §10
  rests on.
- `docs/adr/ADR-001-write-path-enforcement.md` — ACCEPTED 2026-08-17. The shape this ADR
  ports, and the source of the normalization rule in §1.6, the boot-check reasoning in §11,
  and the refuse-to-start reasoning in §2.
- Its `README.md` — the *"Verified against the live account"* / *"Still unverified"* idiom
  that §13.2 and §14 follow.

A Portfolio Boundary Office ruling recording this repo as a **personal (non-venture)
project** is being recorded separately by its owner. **No governance or PBO record is
authored by this ADR.**

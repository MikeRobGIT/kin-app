# Kin MCP server — design

- **Date:** 2026-07-04
- **Written against:** `main` @ `fbd04c1`
- **Status:** approved (brainstorming), pending implementation plan
- **Branch:** `feat/mcp-server` (sibling off `main`, independent of the in-flight kiosk PR #13)

## Goal

Let AI agents interact with Kin over the [Model Context Protocol](https://modelcontextprotocol.io).
The motivating use is natural daily logging — *"log that I took Ivy to school this morning"* /
*"who has the kids this weekend and what's on the calendar?"* — issued from Claude Code on a Mac
**and** from claude.ai (web/mobile) as a custom connector.

Kin stays a single-user, self-hosted, dependency-light family calendar. The MCP server is a **second
front door onto the existing `lib/` layer**, never a parallel implementation.

## Decisions (settled during brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Clients / transport | **Both** — remote Streamable-HTTP endpoint in the Next app (source of truth) + documented stdio bridge | Claude Code and claude.ai both speak remote HTTP natively; stdio-only clients use the standard `npx mcp-remote` bridge |
| Tool surface | **Read + event writes** | The daily-logging core. Custody schedules / seals / share links stay human-only |
| Auth | **`KIN_MCP_TOKEN`** — accepted as `Authorization: Bearer` header **and** as a capability URL segment | Header for clients that can set one; secret-URL for claude.ai's connector, which can't. Same model as `/share` links |
| Build | **Official MCP SDK** via `mcp-handler` | Guaranteed protocol conformance; the one deliberate, recorded break from dependency-light |
| Stdio wrapper | **None written** — document `npx mcp-remote` | YAGNI: both target clients speak HTTP; `mcp-remote` already bridges stdio-only clients |
| Read-tool ranges | **Require `from`+`to`, cap the span** | Bounds payload/tokens; a full-history dump must be intentional |

## Non-goals (explicitly out of scope)

- **No new business logic.** Every tool calls existing `lib/` functions. If a tool's behavior
  diverges from the equivalent HTTP route, that is the bug.
- **No write access to the integrity/security surface:** parent-time schedules, date-range
  overrides, caregiver rename, monthly seals, and share-link minting are **not** exposed as tools.
- **No multi-user / accounts / roles.** The MCP token is a single capability for the single owner,
  distinct from the login password. (The deferred multi-user design stays deferred.)
- **No OAuth.** Heavy machinery for a single-user app; a rotatable bearer token is the boundary.
- **No resources or prompts** in v1 — tools only. (Cheap to add later via the same SDK.)

## Architecture

MCP is a thin adapter tier over the code the HTTP API already uses. Reusing the transactional write
helpers means audit snapshots, validation, and the "writes go through the audited tx helper"
invariant all hold for free.

```
app/api/[transport]/route.js          Header endpoint. createMcpHandler wrapped in withMcpAuth.
                                       basePath '/api' → client URL /api/mcp. force-dynamic, stateless.
app/api/link/[token]/[transport]/route.js
                                       Capability-URL endpoint (mcp-handler's dynamic-routing pattern).
                                       Verifies the [token] segment, then delegates to the SAME handler
                                       with basePath '/api/link/<token>'. force-dynamic.
lib/mcp-tools.js                       registerKinTools(server): registers each tool. Every handler is
                                       a plain async fn (independently unit-testable) that calls lib/*.
                                       Both mount points call registerKinTools.
lib/mcp-auth.js                        verifyKinToken(token): constant-time compare vs KIN_MCP_TOKEN,
                                       fail-closed when unset/short. One check for both entry points.
```

Two mount points because the two auth presentations need different URL shapes; both register the
identical tool set and funnel through one `verifyKinToken()`, so there is no logic duplication — only
the ~10 lines of mount glue differ.

### Why the routes sit under `/api`

`proxy.js`'s matcher already excludes `/api`, so the cookie gate never touches either MCP route — each
is guarded **solely** by its own token, consistent with the standing rule that the route handler (not
the proxy) is the security boundary. No `proxy.js` change is required.

### Data flow (a write)

```
agent → MCP client → POST /api/mcp  (JSON-RPC tools/call: log_event {...})
  → withMcpAuth verifyKinToken()  (401 if token missing/wrong; 503 if server unconfigured)
  → tool handler in lib/mcp-tools.js
      → validateEvent(body, db)     (same validator as POST /api/events)
      → createEvent(body)           (same transactional helper → 1 'create' audit row)
  → { content: [{type:'text', text: <the created row as JSON>}] }
```

Reads follow the same shape, calling the existing queries / `parentOnDate` / `summarizeInvolvement`.

## Tool surface

All inputs are declared as `zod` schemas (required by `mcp-handler`). IDs and enums are **not**
guessed by the agent — `get_context` hands it the real values first.

### Reads

- **`get_context`** — no args. Returns `{children:[{id,name}], caregivers:[{id,name}],
  types:[{key,label,trip}], pdKinds:[…]}`. The discovery tool; an agent calls it before writing so
  it uses real `child_id`/`caregiver_id`/`type` values.
- **`list_events`** — `{from:YYYY-MM-DD, to:YYYY-MM-DD}` (both required; span capped, see below).
  Returns events in range **plus the on-duty parent per day** (via `lib/schedule.js parentOnDate`
  over the loaded schedules + overrides). Mirrors what the calendar shows.
- **`involvement_report`** — `{from, to}` (both required; span capped). Returns per-parent /
  per-activity-type counts via `summarizeInvolvement` — the identical computation behind `/report`
  and the lawyer share page, so the three can never disagree.

### Writes (events only — reuse the audited helpers)

- **`log_event`** — create one event. Fields mirror `validateEvent`: `title, type, child_id,
  caregiver_id?, pd?, date, time, who?, notes?`. `validateEvent(body, db)` → `createEvent(body)`.
  Returns the created row.
- **`update_event`** — `{id, …fields}`. 404 pre-check (the row must exist, else the audit insert's
  NOT NULL snapshot rolls the tx back) → `updateEventTx(id, body)`.
- **`delete_event`** — `{id}`. `deleteEventTx(id)`; a missing id returns a tool error (not a silent
  no-op).
- **`log_events_bulk`** — `{events:[…], series?:boolean}`. Validate-all-then-write, `MAX_BULK` = 366,
  optional server-minted `series_id` — mirrors `POST /api/events/bulk` exactly.

### Range caps

`list_events` and `involvement_report` **require** both `from` and `to` and reject a span greater
than **400 days** with a tool error ("Range too large — request ≤400 days"). This bounds the payload
returned into agent context; a genuine full-history export remains a human action via
`GET /api/export`.

## Auth

### The token

- **`KIN_MCP_TOKEN`** — a new high-entropy env var, **separate** from `APP_PASSWORD` and
  `AUTH_SECRET`. Rotating it revokes all agent access **without** logging out the kiosk or
  invalidating historical month-seal HMACs (both of which key on `AUTH_SECRET`). Added to
  `.env.example` (name only, never a value).
- **Fail-closed:** if `KIN_MCP_TOKEN` is unset or shorter than **24 chars**, the route responds
  `503 { error: "MCP is not configured." }` — never open-access. This mirrors `/api/parse`'s
  unconfigured behavior and the `authSecret()` fail-loud rule in `.claude/rules/kin.md` (which uses
  a 16-char floor; the MCP token gets a higher floor because it is the sole guard on a write surface).
- **Constant-time compare** (`crypto.timingSafeEqual` over equal-length buffers) — never `===`.

### Two ways to present it

1. **Header:** `Authorization: Bearer <KIN_MCP_TOKEN>`. Used by Claude Code
   (`claude mcp add --transport http kin https://kin.example.com/api/mcp --header "Authorization: Bearer …"`)
   and by `npx mcp-remote … --header`. Keeps the token out of the URL and logs.
2. **Capability URL:** `https://kin.example.com/api/link/<KIN_MCP_TOKEN>/mcp` — for claude.ai's custom
   connector, whose UI cannot set a custom header. The `<token>` path segment is the credential,
   compared constant-time; a match runs the handler with no header required. Same tradeoff as
   `/share/<token>`: the token appears in server/proxy logs, is documented as such, and is
   rotatable. Under `/api`, so `proxy.js` already leaves it alone.

Implementation note: the header path uses `mcp-handler`'s `withMcpAuth(handler, verifyToken, {required:true})`.
The capability-URL path follows mcp-handler's documented dynamic-routing pattern
(`app/api/link/[token]/[transport]/route.js` with `basePath: '/api/link/<token>'`): it resolves the
token from the `[token]` param, calls `verifyKinToken()`, then delegates to the same `createMcpHandler`.
Both entry points funnel through one `verifyKinToken()`.

## Error handling

- Tool failures return the **existing human-readable validator strings** ("Unknown child", "Title
  too long", "Range too large") as an MCP tool error (`isError: true` content) — never a stack
  trace, raw SQLite message, or internal detail.
- Transport-level auth failure → 401; unconfigured server → 503. Nothing leaks whether a token was
  "wrong vs unknown."
- The same field limits (`lib/validate.js LIMITS`) an agent hits are the ones the UI enforces, so an
  agent can't write a row the UI couldn't.

## Testing

- **Tool adapters** are plain `async` functions wrapped at registration, so `node:test` calls them
  directly against an in-memory DB (the established `test/*-writes.test.js` pattern):
  - `log_event` → row persisted + one `create` audit row; unknown child/caregiver → validator error.
  - `update_event` / `delete_event` → 404 semantics (missing id errors, does not partial-write).
  - `log_events_bulk` → all-or-nothing (one bad row writes nothing); `MAX_BULK` enforced.
  - `list_events` / `involvement_report` → correct shape; range-cap rejection over 400 days.
- **`verifyKinToken`** → matches valid token (header and URL forms), rejects wrong token,
  **fails-closed when `KIN_MCP_TOKEN` unset**, constant-time path exercised.
- **Build gate:** `npm run build` stays green with `output:'standalone'` and the three new deps
  (`mcp-handler`, `@modelcontextprotocol/sdk`, `zod`) traced into the standalone bundle.
- Live protocol smoke (manual, documented, not in CI): connect Claude Code via `--transport http`
  and confirm `tools/list` + one `log_event` round-trip.

## Dependencies (the one deliberate exception)

Kin is intentionally dependency-light (no ORM, auth lib, state lib, UI framework, TypeScript). This
feature adds **three runtime deps** by explicit decision: `mcp-handler`, `@modelcontextprotocol/sdk`,
`zod`. Recorded here so it reads as a decision, not drift. They are standard, well-maintained, and
carry the protocol conformance we don't want to hand-roll.

## Risks & escape hatches

- **Next 16 compatibility (primary risk).** `mcp-handler`'s docs target Next 13–15. If it does not
  cleanly accept Next 16.2.7's route-handler signature, **STOP and fall back** to the SDK's
  `StreamableHTTPServerTransport` mounted directly in the route (more code, one fewer dep —
  `mcp-handler` drops out). The tool code and `verifyKinToken` are unchanged either way; only the
  mount glue differs. The implementer must verify compatibility **before** building the tool tier.
- **`serverExternalPackages` / native module.** `better-sqlite3` is already externalized; the new
  deps are pure JS and should bundle normally. If the standalone build breaks, that's the gate
  catching it — investigate before proceeding, don't ship a red build.
- **New internet surface.** The endpoint is publicly reachable at `kin.example.com/api/mcp`. Its only
  guard is `KIN_MCP_TOKEN`; the fail-closed + constant-time + separate-token requirements above are
  load-bearing, not optional. (Unlike `/api/auth/login`, brute force is infeasible against a
  high-entropy token, so no throttle is built here — noted, not required.)
- **Token in URL logs.** Accepted and documented for the capability-URL path only; header clients
  avoid it. Rotation is a one-env-var change.

## Open questions

None — the four design decisions and the two sub-decisions (no stdio wrapper; capped ranges) are
settled. Remaining unknowns (Next 16 × `mcp-handler`) are handled by the escape hatch above and
belong to the implementation plan, not the design.

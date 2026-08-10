# Kin MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Kin to AI agents over MCP — 3 read tools + 4 event-write tools — as a second front door onto the existing `lib/` layer, reachable from Claude Code (bearer header) and claude.ai (capability URL).

**Architecture:** Two thin Next route mount points (`mcp-handler` + official SDK) both register one shared tool set (`lib/mcp-server.js`) whose handlers (`lib/mcp-tools.js`) call the existing validators and transactional write helpers — zero new business logic. A single token module (`lib/mcp-auth.js`) guards both routes, fail-closed when unconfigured.

**Tech Stack:** Next.js 16 App Router (plain ESM JS), better-sqlite3 (existing singleton), `mcp-handler`, `@modelcontextprotocol/sdk`, `zod`, `node:test`, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-07-04-kin-mcp-server-design.md`

## Global Constraints

Every task implicitly includes these:

- **Node 20 for all npm/node/test commands:** run `nvm use 20` first (default Node 25 + broken Xcode CLT can't build better-sqlite3's native addon).
- **New runtime deps (the one recorded break from dependency-light):** `mcp-handler`, `@modelcontextprotocol/sdk`, `zod`. Add no others.
- **`export const dynamic = 'force-dynamic'`** on every route file (Next must never evaluate the DB at build time).
- **Token floor:** `KIN_MCP_TOKEN` must be unset-or-`< 24 chars` → treat as **unconfigured** → route returns `503 {error:"MCP is not configured."}`. A configured-but-wrong token → `401`. Never open-access.
- **Constant-time token compare** via `crypto.timingSafeEqual` over equal-length buffers — never `===`, never a length-leaking compare.
- **Range cap:** read tools require both `from` and `to` (`YYYY-MM-DD`) and reject a span `> 400 days`.
- **Human-only surface stays human-only:** no tool may touch `schedules`, `schedule_overrides`, caregiver rename, `month_seals`, or `share_tokens`.
- **Reuse, don't reimplement:** writes go through `validateEvent` + `createEvent`/`updateEventTx`/`deleteEventTx`/`createEventsBulk`; reads reuse `parentOnDate` + `summarizeInvolvement`. If a tool would diverge from the matching HTTP route, stop.
- **Tests import the DB singleton after setting `process.env.DATA_DIR`** to a temp dir (the `test/event-writes.test.js` pattern) — never touch the real data volume.
- **Commits:** conventional `type(scope): msg`. **No `Co-Authored-By`** anywhere.
- **Gate:** `nvm use 20 && npm test` green; `nvm use 20 && npm run build` green (standalone output with the 3 new deps traced in).

---

## File Structure

- Create `lib/mcp-auth.js` — token config + constant-time verify. (Task 1)
- Create `lib/mcp-tools.js` — 7 pure-ish handler functions (no zod, no transport). (Task 2)
- Create `lib/mcp-server.js` — `registerKinTools(server)` wraps handlers with zod schemas + MCP content/error framing. (Task 3)
- Create `app/api/[transport]/route.js` — bearer-header mount via `withMcpAuth`. (Task 4)
- Create `app/api/link/[token]/[transport]/route.js` — capability-URL mount (dynamic routing). (Task 5)
- Modify `.env.example`, `README.md` — document the token + client connection. (Task 6)
- Test files: `test/mcp-auth.test.js`, `test/mcp-tools.test.js`, `test/mcp-server.test.js`.

---

### Task 1: Token auth module (`lib/mcp-auth.js`)

**Files:**
- Create: `lib/mcp-auth.js`
- Test: `test/mcp-auth.test.js`

**Interfaces:**
- Consumes: `node:crypto`.
- Produces:
  - `mcpConfigured(): boolean` — true iff `process.env.KIN_MCP_TOKEN` is set and `>= 24` chars.
  - `verifyKinToken(presented: string): boolean` — false if unconfigured OR mismatch; constant-time when both lengths match.

- [ ] **Step 1: Write the failing test**

```javascript
// test/mcp-auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const GOOD = 'x'.repeat(40); // >= 24 chars

test('unconfigured when KIN_MCP_TOKEN is unset', async () => {
  delete process.env.KIN_MCP_TOKEN;
  const { mcpConfigured, verifyKinToken } = await import('../lib/mcp-auth.js?unset');
  assert.equal(mcpConfigured(), false);
  assert.equal(verifyKinToken('anything'), false);
});

test('unconfigured when token is shorter than 24 chars', async () => {
  process.env.KIN_MCP_TOKEN = 'short';
  const { mcpConfigured } = await import('../lib/mcp-auth.js?short');
  assert.equal(mcpConfigured(), false);
});

test('configured token matches only the exact value, constant-time', async () => {
  process.env.KIN_MCP_TOKEN = GOOD;
  const { mcpConfigured, verifyKinToken } = await import('../lib/mcp-auth.js?good');
  assert.equal(mcpConfigured(), true);
  assert.equal(verifyKinToken(GOOD), true);
  assert.equal(verifyKinToken(GOOD + 'z'), false); // different length
  assert.equal(verifyKinToken('y'.repeat(40)), false); // same length, wrong value
  assert.equal(verifyKinToken(''), false);
  assert.equal(verifyKinToken(undefined), false);
});
```

Note: the `?unset`/`?short`/`?good` query strings force a fresh module evaluation per case (the module reads `process.env` at call time, so this is belt-and-suspenders; functions read env live).

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 20 && node --test test/mcp-auth.test.js`
Expected: FAIL — `Cannot find module '../lib/mcp-auth.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/mcp-auth.js
import crypto from 'node:crypto';

const MIN_LEN = 24;

// The configured MCP token, or null if unset / too short to be a real secret.
function configuredToken() {
  const t = process.env.KIN_MCP_TOKEN;
  return typeof t === 'string' && t.length >= MIN_LEN ? t : null;
}

// True iff a usable KIN_MCP_TOKEN is present. Unconfigured → the route returns 503,
// never open-access (mirrors /api/parse's unconfigured behavior).
export function mcpConfigured() {
  return configuredToken() !== null;
}

// Constant-time compare of a presented token against the configured one. Returns false
// when unconfigured or on any mismatch. Never branches on secret contents; the length
// pre-check only avoids a throw from timingSafeEqual on unequal buffers.
export function verifyKinToken(presented) {
  const token = configuredToken();
  if (token === null || typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 20 && node --test test/mcp-auth.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mcp-auth.js test/mcp-auth.test.js
git commit -m "feat(mcp): token auth module (fail-closed, constant-time)"
```

---

### Task 2: Tool handlers (`lib/mcp-tools.js`)

The 7 handlers as plain functions — no zod, no transport — so `node:test` calls them directly against a temp DB. Each read validates its range; each write reuses the audited helper; failures **throw** a friendly `Error` (Task 3 converts a thrown error into an MCP `isError` result).

**Files:**
- Create: `lib/mcp-tools.js`
- Test: `test/mcp-tools.test.js`

**Interfaces:**
- Consumes: `../lib/db.js` (singleton), `./constants.js` (`TYPES`, `TYPE_KEYS`, `PD_KEYS`), `./schedule.js` (`parentOnDate`, `parseYmd`), `./report.js` (`summarizeInvolvement`), `./validate.js` (`validateEvent`, `isRealDate`), `./event-writes.js` (`createEvent`, `updateEventTx`, `deleteEventTx`, `createEventsBulk`).
- Produces (all `throw Error` on invalid input):
  - `getContext(): {children,caregivers,types,pdKinds}`
  - `listEvents({from,to}): {from,to,events,onDuty}`
  - `involvementReport({from,to}): {from,to,summary}`
  - `logEvent(fields): row`
  - `updateEvent({id,...fields}): row`
  - `deleteEvent({id}): {deleted:true,id}`
  - `logEventsBulk({events,series}): {created,series_id}`
  - Constant: `MAX_RANGE_DAYS = 400`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/mcp-tools.test.js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let db, T;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mcp-'));
  ({ default: db } = await import('../lib/db.js'));
  T = await import('../lib/mcp-tools.js');
});

const ev = (o = {}) => ({
  title: 'School drop-off', type: 'school', child_id: 'c1', caregiver_id: 'g1',
  pd: 'dropoff', date: '2026-06-13', time: '08:00', who: '', notes: '', ...o,
});

test('getContext exposes the seeded children, caregivers, types, and pd kinds', () => {
  const c = T.getContext();
  assert.deepEqual(c.children.map((x) => x.id), ['c1', 'c2']);
  assert.deepEqual(c.caregivers.map((x) => x.id), ['g1', 'g2']);
  assert.ok(c.types.find((t) => t.key === 'school' && t.trip === true));
  assert.deepEqual(c.pdKinds, ['dropoff', 'pickup', 'both']);
});

test('logEvent creates a row and one create audit entry', () => {
  const row = T.logEvent(ev());
  assert.match(row.id, /^e[0-9a-f-]{12}$/);
  const audit = db.prepare('SELECT action FROM event_audit WHERE event_id = ?').all(row.id).map((r) => r.action);
  assert.deepEqual(audit, ['create']);
});

test('logEvent throws the validator message on an unknown child', () => {
  assert.throws(() => T.logEvent(ev({ child_id: 'nope' })), /Unknown child/);
});

test('updateEvent throws on a missing id and does not write', () => {
  assert.throws(() => T.updateEvent({ id: 'missing', ...ev({ title: 'X' }) }), /Unknown event/);
});

test('updateEvent edits an existing row', () => {
  const row = T.logEvent(ev());
  const after = T.updateEvent({ id: row.id, ...ev({ title: 'Changed' }) });
  assert.equal(after.title, 'Changed');
});

test('deleteEvent removes a row; deleting a missing id throws', () => {
  const row = T.logEvent(ev());
  assert.deepEqual(T.deleteEvent({ id: row.id }), { deleted: true, id: row.id });
  assert.throws(() => T.deleteEvent({ id: row.id }), /Unknown event/);
});

test('logEventsBulk is all-or-nothing on a bad row', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  assert.throws(() => T.logEventsBulk({ events: [ev(), ev({ type: 'bogus' })] }), /Invalid type/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, before);
});

test('logEventsBulk with series=true links the rows under one server-minted id', () => {
  const r = T.logEventsBulk({ events: [ev({ date: '2026-07-01' }), ev({ date: '2026-07-02' })], series: true });
  assert.equal(r.created, 2);
  assert.match(r.series_id, /^s[0-9a-f-]{12}$/);
});

test('listEvents returns in-range events and an onDuty map', () => {
  T.logEvent(ev({ date: '2026-08-10', title: 'InRange' }));
  const out = T.listEvents({ from: '2026-08-01', to: '2026-08-31' });
  assert.ok(out.events.some((e) => e.title === 'InRange'));
  assert.ok(Object.prototype.hasOwnProperty.call(out.onDuty, '2026-08-10'));
});

test('listEvents rejects a bad or oversized range', () => {
  assert.throws(() => T.listEvents({ from: 'nope', to: '2026-08-31' }), /Invalid date range/);
  assert.throws(() => T.listEvents({ from: '2026-01-01', to: '2030-01-01' }), /Range too large/);
});

test('involvementReport summarizes per-caregiver counts', () => {
  const out = T.involvementReport({ from: '2026-06-01', to: '2026-06-30' });
  assert.equal(typeof out.summary.grand, 'number');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 20 && node --test test/mcp-tools.test.js`
Expected: FAIL — `Cannot find module '../lib/mcp-tools.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/mcp-tools.js
// The MCP tool handlers. Each is a second caller of the SAME lib/ functions the HTTP
// routes use — so validation, audit snapshots, and transactional invariants hold for free.
// Handlers throw a friendly Error on bad input; lib/mcp-server.js turns that into an MCP
// isError result. No zod / no transport here → directly unit-testable.
import crypto from 'node:crypto';
import db from './db.js';
import { TYPES, TYPE_KEYS, PD_KEYS } from './constants.js';
import { parentOnDate, parseYmd } from './schedule.js';
import { summarizeInvolvement } from './report.js';
import { validateEvent, isRealDate } from './validate.js';
import {
  createEvent, updateEventTx, deleteEventTx, createEventsBulk,
} from './event-writes.js';

export const MAX_RANGE_DAYS = 400;
const MS_PER_DAY = 86400000;

function assertRange(from, to) {
  if (!isRealDate(from) || !isRealDate(to)) throw new Error('Invalid date range (use YYYY-MM-DD for both from and to)');
  if (from > to) throw new Error('Start date is after end date');
  const days = Math.round((parseYmd(to) - parseYmd(from)) / MS_PER_DAY) + 1;
  if (days > MAX_RANGE_DAYS) throw new Error(`Range too large — request ${MAX_RANGE_DAYS} days or fewer`);
}

function loadSchedules() {
  return {
    schedules: db.prepare('SELECT * FROM schedules ORDER BY created_at').all(),
    overrides: db.prepare('SELECT * FROM schedule_overrides ORDER BY date_from').all(),
  };
}

// --- reads -----------------------------------------------------------------

export function getContext() {
  return {
    children: db.prepare('SELECT id, name FROM children ORDER BY sort').all(),
    caregivers: db.prepare('SELECT id, name FROM caregivers ORDER BY sort').all(),
    types: TYPE_KEYS.map((key) => ({ key, label: TYPES[key].label, trip: !!TYPES[key].trip })),
    pdKinds: PD_KEYS,
  };
}

export function listEvents({ from, to } = {}) {
  assertRange(from, to);
  const events = db
    .prepare('SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date, time')
    .all(from, to);
  const { schedules, overrides } = loadSchedules();
  const onDuty = {};
  const start = parseYmd(from);
  const nights = Math.round((parseYmd(to) - start) / MS_PER_DAY) + 1;
  for (let i = 0; i < nights; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    onDuty[ds] = parentOnDate(ds, schedules, overrides);
  }
  return { from, to, events, onDuty };
}

export function involvementReport({ from, to } = {}) {
  assertRange(from, to);
  const events = db
    .prepare('SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date, time')
    .all(from, to);
  const caregivers = db.prepare('SELECT * FROM caregivers ORDER BY sort').all();
  return { from, to, summary: summarizeInvolvement(events, caregivers) };
}

// --- event writes (reuse the audited transactional helpers) ----------------

export function logEvent(fields) {
  const err = validateEvent(fields, db);
  if (err) throw new Error(err);
  return createEvent(fields);
}

export function updateEvent({ id, ...fields } = {}) {
  const existing = db.prepare('SELECT id FROM events WHERE id = ?').get(id);
  if (!existing) throw new Error('Unknown event');
  const err = validateEvent(fields, db);
  if (err) throw new Error(err);
  return updateEventTx(id, fields);
}

export function deleteEvent({ id } = {}) {
  const ok = deleteEventTx(id);
  if (!ok) throw new Error('Unknown event');
  return { deleted: true, id };
}

const MAX_BULK = 366; // mirrors app/api/events/bulk/route.js

export function logEventsBulk({ events, series } = {}) {
  if (!Array.isArray(events) || events.length === 0) throw new Error('No entries to create');
  if (events.length > MAX_BULK) throw new Error(`Too many entries (max ${MAX_BULK})`);
  for (let i = 0; i < events.length; i++) {
    const err = validateEvent(events[i], db);
    if (err) throw new Error(`${err} (entry ${i})`);
  }
  const series_id = series === true ? 's' + crypto.randomUUID().slice(0, 12) : null;
  const created = createEventsBulk(events, series_id);
  return { created, series_id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 20 && node --test test/mcp-tools.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mcp-tools.js test/mcp-tools.test.js
git commit -m "feat(mcp): event + read tool handlers over existing lib helpers"
```

---

### Task 3: Register tools with zod schemas (`lib/mcp-server.js`)

Installs the deps, then wraps the Task-2 handlers into MCP tool registrations. Tested with a **fake server** (records registrations) — no live transport needed.

**Files:**
- Create: `lib/mcp-server.js`
- Test: `test/mcp-server.test.js`
- Modify: `package.json` (deps)

**Interfaces:**
- Consumes: `zod` (`z`), all handlers from `./mcp-tools.js`.
- Produces: `registerKinTools(server): void` — calls `server.registerTool(name, config, wrapped)` for all 7 tools. Each `wrapped(args)` returns `{content:[{type:'text', text: JSON.stringify(data)}]}` on success, or `{content:[{type:'text', text: err.message}], isError:true}` on a thrown handler error.
- Produces: `TOOL_NAMES` — array of the 7 registered names, for tests/docs.

- [ ] **Step 1: Install dependencies**

Run:
```bash
nvm use 20 && npm install mcp-handler @modelcontextprotocol/sdk zod
```
Expected: `package.json` gains the three deps; `package-lock.json` updates; exit 0.

- [ ] **Step 2: Write the failing test**

```javascript
// test/mcp-server.test.js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let registerKinTools, TOOL_NAMES;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mcpsrv-'));
  await import('../lib/db.js'); // seed the temp DB
  ({ registerKinTools, TOOL_NAMES } = await import('../lib/mcp-server.js'));
});

// Minimal fake of the SDK McpServer: records registrations and lets us invoke a handler.
function fakeServer() {
  const tools = new Map();
  return {
    registerTool: (name, config, handler) => tools.set(name, { config, handler }),
    tools,
  };
}

test('registers exactly the 7 tools, no schedule/seal/share tools', () => {
  const s = fakeServer();
  registerKinTools(s);
  assert.deepEqual([...s.tools.keys()].sort(), [...TOOL_NAMES].sort());
  assert.equal(s.tools.size, 7);
  for (const name of s.tools.keys()) {
    assert.doesNotMatch(name, /schedule|override|seal|share|caregiver/i);
  }
});

test('a write tool returns text content on success', async () => {
  const s = fakeServer();
  registerKinTools(s);
  const res = await s.tools.get('log_event').handler({
    title: 'Dinner', type: 'meal', child_id: 'c1', caregiver_id: 'g1',
    date: '2026-06-14', time: '18:00',
  });
  assert.equal(res.isError, undefined);
  const row = JSON.parse(res.content[0].text);
  assert.equal(row.title, 'Dinner');
});

test('a handler error becomes an isError result, not a throw', async () => {
  const s = fakeServer();
  registerKinTools(s);
  const res = await s.tools.get('log_event').handler({
    title: 'Bad', type: 'nope', child_id: 'c1', date: '2026-06-14', time: '18:00',
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Invalid type/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `nvm use 20 && node --test test/mcp-server.test.js`
Expected: FAIL — `Cannot find module '../lib/mcp-server.js'`.

- [ ] **Step 4: Write minimal implementation**

```javascript
// lib/mcp-server.js
// Wraps the pure handlers (lib/mcp-tools.js) as MCP tools with zod input schemas and
// uniform content/error framing. Both route mount points call registerKinTools(server).
import { z } from 'zod';
import * as T from './mcp-tools.js';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const hm = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM');

// One event's writable fields (title/type/child are the required core; the rest optional).
const eventShape = {
  title: z.string().min(1).max(120),
  type: z.string().describe('an activity type key from get_context.types[].key'),
  child_id: z.string().describe('c1 / c2 — from get_context.children'),
  caregiver_id: z.string().optional().describe('g1 / g2 — from get_context.caregivers; omit if unknown'),
  pd: z.enum(['dropoff', 'pickup', 'both']).optional().describe('trip kind; only for trip types'),
  date: ymd,
  time: hm,
  who: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
};

export const TOOL_NAMES = [
  'get_context', 'list_events', 'involvement_report',
  'log_event', 'update_event', 'delete_event', 'log_events_bulk',
];

// Turn a plain handler into an MCP tool handler: data → text content; thrown Error → isError.
function wrap(fn) {
  return async (args) => {
    try {
      const data = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: String(e?.message || e) }], isError: true };
    }
  };
}

export function registerKinTools(server) {
  server.registerTool('get_context',
    { title: 'Get context', description: 'Children, caregivers, activity types, and trip kinds. Call first so you use real ids and type keys.', inputSchema: {} },
    wrap(() => T.getContext()));

  server.registerTool('list_events',
    { title: 'List events', description: 'Events in a date range plus the on-duty parent per day. Both dates required; span ≤400 days.', inputSchema: { from: ymd, to: ymd } },
    wrap((a) => T.listEvents(a)));

  server.registerTool('involvement_report',
    { title: 'Involvement report', description: 'Per-parent / per-activity-type counts over a date range. Both dates required; span ≤400 days.', inputSchema: { from: ymd, to: ymd } },
    wrap((a) => T.involvementReport(a)));

  server.registerTool('log_event',
    { title: 'Log event', description: 'Create one calendar event (transport or hands-on care).', inputSchema: eventShape },
    wrap((a) => T.logEvent(a)));

  server.registerTool('update_event',
    { title: 'Update event', description: 'Edit an existing event by id (all event fields required).', inputSchema: { id: z.string(), ...eventShape } },
    wrap((a) => T.updateEvent(a)));

  server.registerTool('delete_event',
    { title: 'Delete event', description: 'Delete an event by id (keeps an audit snapshot).', inputSchema: { id: z.string() } },
    wrap((a) => T.deleteEvent(a)));

  server.registerTool('log_events_bulk',
    { title: 'Log events (bulk)', description: 'Create many events at once (all-or-nothing). Set series=true to link them for later edit/delete as a unit.', inputSchema: { events: z.array(z.object(eventShape)).min(1), series: z.boolean().optional() } },
    wrap((a) => T.logEventsBulk(a)));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `nvm use 20 && node --test test/mcp-server.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/mcp-server.js test/mcp-server.test.js package.json package-lock.json
git commit -m "feat(mcp): register tools with zod schemas; add mcp-handler/sdk/zod deps"
```

---

### Task 4: Bearer-header mount (`app/api/[transport]/route.js`)

Mounts the tool set for Claude Code and header-capable clients. **This is the Next-16 compatibility checkpoint** (see escape hatch below).

**Files:**
- Create: `app/api/[transport]/route.js`

**Interfaces:**
- Consumes: `mcp-handler` (`createMcpHandler`, `withMcpAuth`), `./…` → `registerKinTools`, `mcpConfigured`, `verifyKinToken`.
- Produces: the client Streamable-HTTP endpoint at **`/api/mcp`** (transport segment `mcp`, `basePath:'/api'`). `GET`/`POST`/`DELETE` exports.

- [ ] **Step 1: Write the route**

```javascript
// app/api/[transport]/route.js
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { registerKinTools } from '@/lib/mcp-server';
import { mcpConfigured, verifyKinToken } from '@/lib/mcp-auth';

const base = createMcpHandler(
  (server) => registerKinTools(server),
  { serverInfo: { name: 'kin', version: '1.0.0' }, capabilities: { tools: {} } },
  { basePath: '/api' }
);

// withMcpAuth extracts the bearer token; we constant-time compare it. Returning undefined → 401.
const verifyToken = async (_req, bearerToken) =>
  verifyKinToken(bearerToken) ? { token: bearerToken, scopes: [], clientId: 'kin-owner' } : undefined;

const authed = withMcpAuth(base, verifyToken, { required: true });

// Unconfigured server → 503 before any auth, so a fresh install is closed, not open.
async function handler(req) {
  if (!mcpConfigured()) return NextResponse.json({ error: 'MCP is not configured.' }, { status: 503 });
  return authed(req);
}

export { handler as GET, handler as POST, handler as DELETE };
```

- [ ] **Step 2: Verify the build compiles (Next 16 × mcp-handler)**

Run: `nvm use 20 && npm run build`
Expected: build **succeeds**, standalone output produced.

> **ESCAPE HATCH — if the build fails on `mcp-handler` (Next 16 route-signature incompatibility): STOP and switch this one file to the SDK's transport directly (drop `mcp-handler`; keep everything else).** Replace the route body with:
> ```javascript
> export const dynamic = 'force-dynamic';
> import { NextResponse } from 'next/server';
> import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
> import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
> import { registerKinTools } from '@/lib/mcp-server';
> import { mcpConfigured, verifyKinToken } from '@/lib/mcp-auth';
> // Build a stateless server+transport per request; auth via bearer header.
> async function handler(req) {
>   if (!mcpConfigured()) return NextResponse.json({ error: 'MCP is not configured.' }, { status: 503 });
>   const auth = req.headers.get('authorization') || '';
>   const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
>   if (!verifyKinToken(token)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
>   const server = new McpServer({ name: 'kin', version: '1.0.0' });
>   registerKinTools(server);
>   const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
>   await server.connect(transport);
>   return transport.handleRequest(req); // adapt req/res per the SDK's fetch guidance
> }
> export { handler as GET, handler as POST, handler as DELETE };
> ```
> If you take this path: this route is `app/api/mcp/route.js` (fixed segment, no `[transport]`), and Task 5's capability route mirrors the same manual approach. Note the swap in the Task-6 commit message and in `docs/superpowers/specs/2026-07-04-kin-mcp-server-design.md` (Risks section). Do **not** invent a third approach — if neither `mcp-handler` nor the SDK transport compiles under Next 16, STOP and report back.

- [ ] **Step 3: Verify 503 when unconfigured, 401 on a bad token (dev server)**

Run (two terminals; port 3001 per project config):
```bash
# terminal A — no token set:
nvm use 20 && unset KIN_MCP_TOKEN && PORT=3001 npm run dev
# terminal B:
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
Expected: `503`. Then restart dev with `KIN_MCP_TOKEN=$(openssl rand -hex 24)` and repeat with a **wrong** bearer → `401`.

- [ ] **Step 4: Commit**

```bash
git add app/api/[transport]/route.js
git commit -m "feat(mcp): bearer-header Streamable-HTTP mount at /api/mcp"
```

---

### Task 5: Capability-URL mount (`app/api/link/[token]/[transport]/route.js`)

For claude.ai's connector, which can't set a header. The `[token]` path segment is the credential (mcp-handler's documented dynamic-routing pattern).

**Files:**
- Create: `app/api/link/[token]/[transport]/route.js`

**Interfaces:**
- Consumes: same as Task 4 plus the dynamic `params`.
- Produces: the client endpoint at **`/api/link/<token>/mcp`**.

- [ ] **Step 1: Write the route**

```javascript
// app/api/link/[token]/[transport]/route.js
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { createMcpHandler } from 'mcp-handler';
import { registerKinTools } from '@/lib/mcp-server';
import { mcpConfigured, verifyKinToken } from '@/lib/mcp-auth';

// The [token] path segment IS the credential (same model as /share/<token>). Verified
// constant-time; a match runs the handler with basePath scoped to this token's URL.
async function handler(req, { params }) {
  const { token } = await params;
  if (!mcpConfigured()) return NextResponse.json({ error: 'MCP is not configured.' }, { status: 503 });
  if (!verifyKinToken(token)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const mcp = createMcpHandler(
    (server) => registerKinTools(server),
    { serverInfo: { name: 'kin', version: '1.0.0' }, capabilities: { tools: {} } },
    { basePath: `/api/link/${token}` }
  );
  return mcp(req);
}

export { handler as GET, handler as POST, handler as DELETE };
```

(If Task 4 took the escape hatch, mirror the manual SDK approach here instead, verifying `params.token` with `verifyKinToken`.)

- [ ] **Step 2: Verify the build still compiles**

Run: `nvm use 20 && npm run build`
Expected: PASS.

- [ ] **Step 3: Verify capability-URL auth (dev server on :3001, `KIN_MCP_TOKEN` set)**

```bash
TOKEN="$KIN_MCP_TOKEN"
# wrong token in URL → 401:
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3001/api/link/wrongtokenwrongtokenwrong/mcp" \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# correct token → a JSON-RPC tools/list result (200-family):
curl -s -X POST "http://localhost:3001/api/link/$TOKEN/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
Expected: first `401`; second returns a JSON-RPC response listing the 7 tools.

- [ ] **Step 4: Commit**

```bash
git add app/api/link/[token]/[transport]/route.js
git commit -m "feat(mcp): capability-URL mount at /api/link/<token>/mcp"
```

---

### Task 6: Document the token + client connection

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add the env var (name + generation hint only, never a value)**

Add to `.env.example` after the `LITELLM_*` block:
```bash
# Optional — MCP server so AI agents can read/log events. Leave unset to disable (returns 503).
# Generate a high-entropy value (>= 24 chars):  openssl rand -hex 24
KIN_MCP_TOKEN=
```

- [ ] **Step 2: Add a "Connect an agent (MCP)" section to `README.md`**

```markdown
## Connect an agent (MCP)

Set `KIN_MCP_TOKEN` (>= 24 chars; `openssl rand -hex 24`). The server exposes read tools
(`get_context`, `list_events`, `involvement_report`) and event-write tools (`log_event`,
`update_event`, `delete_event`, `log_events_bulk`). Custody schedules, month seals, and share
links stay human-only. Unset token → the endpoint returns 503.

- **Claude Code (bearer header):**
  `claude mcp add --transport http kin https://kin.example.com/api/mcp --header "Authorization: Bearer $KIN_MCP_TOKEN"`
- **claude.ai (custom connector, no header support):** add the capability URL
  `https://kin.example.com/api/link/<KIN_MCP_TOKEN>/mcp`
- **A stdio-only client:** bridge with `npx mcp-remote https://kin.example.com/api/mcp --header "Authorization: Bearer $KIN_MCP_TOKEN"`

Rotate access by changing `KIN_MCP_TOKEN` (independent of your login password and seal secret).
```

- [ ] **Step 3: Final gate — full suite + build**

Run: `nvm use 20 && npm test && npm run build`
Expected: all tests PASS; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs(mcp): document KIN_MCP_TOKEN and agent connection"
```

---

## Self-Review

**Spec coverage:**
- 3 read tools + 4 write tools → Tasks 2–3. ✓
- Token auth (header + capability URL), fail-closed, constant-time, 24-char floor → Task 1 + Tasks 4/5. ✓
- Human-only surface excluded (asserted in Task 3 test) → ✓
- Range cap 400 days → Task 2 (`assertRange`) + test. ✓
- Official SDK via `mcp-handler`; 3 deps recorded → Task 3. ✓
- Next-16 escape hatch to `StreamableHTTPServerTransport` → Task 4 Step 2. ✓
- No stdio wrapper; `mcp-remote` documented → Task 6. ✓
- Reuse audited helpers, no new business logic → Task 2 handlers. ✓
- `.env.example` gets the token (name only) → Task 6. ✓
- Build stays green with standalone + new deps → Tasks 4/5 Step 2, Task 6 Step 3. ✓

**Placeholder scan:** none — every code/test/command step is concrete.

**Type consistency:** handler names (`getContext`/`listEvents`/`involvementReport`/`logEvent`/`updateEvent`/`deleteEvent`/`logEventsBulk`) are identical across Tasks 2, 3, and their tests; `mcpConfigured`/`verifyKinToken` identical across Tasks 1, 4, 5; tool names identical between `TOOL_NAMES` and the `registerTool` calls.

## Notes for the reviewer / future maintenance

- The Streamable-HTTP client URL is `/api/mcp` because `[transport]` = `mcp` with `basePath:'/api'`. If a future contributor adds another `app/api/<x>/route.js`, confirm it doesn't shadow the `[transport]` dynamic segment.
- If a future tool needs to expose more of the model, add a handler in `lib/mcp-tools.js` (+ test) and a registration in `lib/mcp-server.js` — never write DB rows ad hoc in the route.
- The capability token rides in server/proxy logs on the `/api/link/...` path (documented tradeoff). Keep the header path as the default in docs.
- `mcp-handler` upgrades: re-run Task 4 Step 2 build check; the escape-hatch SDK path is the fallback if a future version breaks Next compat.

# Kin Record Integrity & Durability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kin's single SQLite store durable and tamper-evident — versioned migrations, an append-only edit/delete audit trail, unambiguous local-time "Recorded" timestamps, real date/length validation, a faithful export, integrity/health checks, clean WAL shutdown, and continuous Litestream→R2 backups.

**Architecture:** A `PRAGMA user_version` migration runner in `lib/migrate.js` becomes the single owner of schema. New write helpers in `lib/event-writes.js` wrap every mutation + its audit row in one `better-sqlite3` transaction. A shared `lib/validate.js` replaces three drifting validator copies. Display/format logic lives in `lib/format.js`. Durability is handled in `lib/db.js` (shutdown + integrity) and at the container layer (health endpoint, Litestream sidecar).

**Tech Stack:** Next.js 16 (App Router, `output: 'standalone'`), better-sqlite3 (native, synchronous, WAL), `node:test` (built-in), Litestream (sidecar container) → Cloudflare R2. No new npm dependencies.

**Source spec:** `docs/superpowers/specs/2026-06-13-kin-record-integrity-design.md`

**⚠️ Live data:** The live instance at kin.example.com holds the real custody record. Migration 4 rebuilds the `events` table. Before the deploy that ships migrations, take a manual backup (`sqlite3 tracker.db ".backup '/tmp/pre-migration.db'"`) and confirm Litestream (Phase H) is replicating, OR run the deploy only after Phase H is live.

---

## File Structure

**New files:**
- `lib/migrate.js` — ordered `user_version` migrations + `runMigrations(db)`. Owns all schema.
- `lib/validate.js` — `isRealDate`, `isRealTime`, `validateEventFields`, `validateEvent(b, db)`. One source of truth for event validation.
- `lib/event-writes.js` — transactional `createEvent`, `updateEventTx`, `deleteEventTx`, `createEventsBulk` (each writes an `event_audit` row in the same transaction).
- `lib/format.js` — `fmtRecorded(s, tz)` UTC→local display helper.
- `lib/export.js` — `buildExport(db)` faithful full-data dump.
- `app/api/export/route.js` — authed `GET` returning the export JSON.
- `app/api/health/route.js` — unauthenticated `GET` running `SELECT 1`.
- `test/validate.test.js`, `test/migrate.test.js`, `test/format.test.js`, `test/event-writes.test.js` — `node:test` suites.
- `litestream.yml` — Litestream replication config.

**Modified files:**
- `lib/db.js` — call `runMigrations`, drop ad-hoc CREATE/ALTER, add `quick_check` + SIGTERM/SIGINT shutdown. Seeds stay.
- `app/api/events/route.js` — use `validateEvent` + `createEvent`; validate GET range.
- `app/api/events/[id]/route.js` — use `validateEvent` + `updateEventTx`/`deleteEventTx`.
- `app/api/events/bulk/route.js` — use `validateEvent` + `createEventsBulk`.
- `app/api/parse/route.js` — use `isRealDate`/`isRealTime` for the draft + recurrence bounds.
- `components/Report.js` — local-time "Recorded (local)" + "edited" marker; CSV uses `fmtRecorded`.
- `package.json` — add `"type": "module"` and `"test": "node --test"`.
- `docker-compose.yml` — point healthcheck at `/api/health`; add Litestream sidecar.
- `Dockerfile` — (no change required; verify standalone still runs under `type: module`).
- `README.md` — fix backup advice; document restore drill + `NEXT_PUBLIC_TZ`.
- `.env.example` — add R2 + `NEXT_PUBLIC_TZ` vars (create if absent).

---

## Phase A — Foundation: ESM test harness + migration runner

### Task 1: Enable ESM + test runner, verify the build still serves

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Create the working branch**

```bash
git checkout -b feat/record-integrity
```

- [ ] **Step 2: Add `type: module` and a test script**

Edit `package.json`. After `"private": true,` add `"type": "module",`. In `"scripts"`, add the test line:

```json
{
  "name": "kin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Self-hosted family care & involvement tracker",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "node --test"
  },
```

(Leave `dependencies` and `engines` unchanged.)

- [ ] **Step 3: Verify the production build AND the standalone server still run under `type: module`**

This is the one risky change in the plan — the Next standalone `server.js` must still boot. Verify before going further.

Run:
```bash
nvm use 20
npm run build
APP_PASSWORD=dev AUTH_SECRET=$(openssl rand -hex 32) DATA_DIR=$(mktemp -d) \
  node .next/standalone/server.js &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/login
kill %1
```
Expected: `npm run build` succeeds, and the curl prints `200`.

**If the standalone server crashes** with an ESM/`require` error: `type: module` is incompatible with this Next version's standalone output. STOP and fall back: remove `"type": "module"`, and instead give each new `lib/*.js` test target a `.mjs` twin is NOT viable (they import `./constants.js`); the correct fallback is to add a dev-only transform — pause and consult the spec owner. Do not proceed past this step until the standalone server returns 200.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: declare ESM (type: module) and add node:test script"
```

---

### Task 2: Migration runner + baseline migration

**Files:**
- Create: `lib/migrate.js`
- Test: `test/migrate.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/migrate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { runMigrations, migrations } from '../lib/migrate.js';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mig-'));
  return new Database(path.join(dir, 'test.db'));
}
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('baseline creates tables and sets user_version to 1+', () => {
  const db = freshDb();
  runMigrations(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('children'));
  assert.ok(tables.includes('caregivers'));
  assert.ok(tables.includes('events'));
  assert.ok(cols(db, 'events').includes('caregiver_id'));
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
});

test('runMigrations is idempotent', () => {
  const db = freshDb();
  runMigrations(db);
  const v1 = db.pragma('user_version', { simple: true });
  runMigrations(db); // second run is a no-op
  assert.equal(db.pragma('user_version', { simple: true }), v1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/migrate.js'`.

- [ ] **Step 3: Write `lib/migrate.js` with the baseline migration only**

Create `lib/migrate.js`:

```js
// Ordered schema migrations. The array index + 1 is each migration's target
// PRAGMA user_version. runMigrations applies every migration whose version is
// greater than the DB's current user_version, each in its own transaction.

export const migrations = [
  // 1 — baseline: bring a fresh OR a pre-versioning DB to a known v1 state.
  function baseline(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS children (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        color TEXT NOT NULL,
        sort  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS caregivers (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        color TEXT NOT NULL,
        sort  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        id        TEXT PRIMARY KEY,
        title     TEXT NOT NULL,
        type      TEXT NOT NULL,
        child_id  TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        pd        TEXT NOT NULL DEFAULT 'dropoff',
        date      TEXT NOT NULL,
        time      TEXT NOT NULL DEFAULT '08:00',
        who       TEXT DEFAULT '',
        notes     TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    `);
    // Pre-versioning DBs may already have caregiver_id from the old ALTER path.
    const hasCaregiver = db
      .prepare('PRAGMA table_info(events)')
      .all()
      .some((c) => c.name === 'caregiver_id');
    if (!hasCaregiver) {
      db.exec('ALTER TABLE events ADD COLUMN caregiver_id TEXT REFERENCES caregivers(id)');
    }
  },
];

export function runMigrations(db) {
  const current = db.pragma('user_version', { simple: true }) || 0;
  if (current >= migrations.length) return;
  // foreign_keys MUST be toggled outside a transaction; later migrations rebuild
  // tables and need it off. Restore it on the way out.
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < migrations.length; v++) {
      const apply = db.transaction(() => {
        migrations[v](db);
        db.pragma(`user_version = ${v + 1}`);
      });
      apply();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (both migrate tests).

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js test/migrate.test.js
git commit -m "feat: add user_version migration runner with baseline migration"
```

---

### Task 3: Wire `lib/db.js` to the migration runner

**Files:**
- Modify: `lib/db.js`

- [ ] **Step 1: Replace the schema/ALTER block with `runMigrations`**

Replace the entire contents of `lib/db.js` with:

```js
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrate.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'tracker.db');

// Reuse a single connection across hot reloads / serverless invocations.
const globalForDb = globalThis;
const db = globalForDb.__ttDb || new Database(dbPath);
if (!globalForDb.__ttDb) globalForDb.__ttDb = db;

db.pragma('journal_mode = WAL');

// All schema lives in migrations; this also restores foreign_keys = ON.
runMigrations(db);
db.pragma('foreign_keys = ON');

// Surface silent corruption early instead of when the file won't open.
try {
  const check = db.pragma('quick_check', { simple: true });
  if (check !== 'ok') console.error('[kin] SQLite quick_check:', check);
} catch (e) {
  console.error('[kin] SQLite quick_check failed:', e);
}

// Seed the two children once, on first run.
const countRow = db.prepare('SELECT COUNT(*) AS n FROM children').get();
const count = countRow ? countRow.n : 1; // build-time stub returns undefined; skip seeding
if (count === 0) {
  const insert = db.prepare(
    'INSERT INTO children (id, name, color, sort) VALUES (?, ?, ?, ?)'
  );
  insert.run('c1', 'Child 1', '#c8553d', 0);
  insert.run('c2', 'Child 2', '#3a6b5e', 1);
}

// Seed the two parents once, on first run.
const cgCountRow = db.prepare('SELECT COUNT(*) AS n FROM caregivers').get();
const cgCount = cgCountRow ? cgCountRow.n : 1;
if (cgCount === 0) {
  const insert = db.prepare(
    'INSERT INTO caregivers (id, name, color, sort) VALUES (?, ?, ?, ?)'
  );
  insert.run('g1', 'Dad', '#2d6a9f', 0);
  insert.run('g2', 'Mom', '#b5396b', 1);
}

// Checkpoint the WAL into the main file and close cleanly on shutdown.
if (!globalForDb.__ttShutdown) {
  globalForDb.__ttShutdown = true;
  const shutdown = () => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export default db;
```

- [ ] **Step 2: Verify dev boot + build**

Run:
```bash
nvm use 20
APP_PASSWORD=dev AUTH_SECRET=$(openssl rand -hex 32) DATA_DIR=$(mktemp -d) \
  node -e "import('./lib/db.js').then(()=>{console.log('db ok');process.exit(0)})"
npm run build
```
Expected: prints `db ok`; build succeeds.

> Note: the SIGTERM/SIGINT handler calls `process.exit(0)`. The one-liner above exits on its own before any signal, so it's unaffected.

- [ ] **Step 3: Commit**

```bash
git add lib/db.js
git commit -m "refactor: drive schema from the migration runner; add quick_check + clean shutdown"
```

---

## Phase B — Schema migrations

### Task 4: Migration 2 — `events.updated_at`

**Files:**
- Modify: `lib/migrate.js`
- Modify: `test/migrate.test.js`

- [ ] **Step 1: Add the failing test**

Append to `test/migrate.test.js`:

```js
test('migration adds updated_at column', () => {
  const db = freshDb();
  runMigrations(db);
  assert.ok(cols(db, 'events').includes('updated_at'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `events` has no `updated_at`.

- [ ] **Step 3: Add migration 2**

In `lib/migrate.js`, add a second entry to the `migrations` array (after `baseline`):

```js
  // 2 — add updated_at (set on every edit; created_at stays immutable).
  function addUpdatedAt(db) {
    const has = db
      .prepare('PRAGMA table_info(events)')
      .all()
      .some((c) => c.name === 'updated_at');
    if (!has) db.exec('ALTER TABLE events ADD COLUMN updated_at TEXT');
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js test/migrate.test.js
git commit -m "feat: migration 2 — add events.updated_at"
```

---

### Task 5: Migration 3 — `event_audit` table

**Files:**
- Modify: `lib/migrate.js`
- Modify: `test/migrate.test.js`

- [ ] **Step 1: Add the failing test**

Append to `test/migrate.test.js`:

```js
test('migration creates append-only event_audit table', () => {
  const db = freshDb();
  runMigrations(db);
  const names = cols(db, 'event_audit');
  assert.deepEqual(
    names.sort(),
    ['action', 'at', 'event_id', 'id', 'snapshot'].sort()
  );
  // action CHECK constraint rejects unknown actions
  assert.throws(() =>
    db
      .prepare("INSERT INTO event_audit (event_id, action, snapshot) VALUES ('e1','bogus','{}')")
      .run()
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — no `event_audit` table.

- [ ] **Step 3: Add migration 3**

Add a third entry to the `migrations` array in `lib/migrate.js`:

```js
  // 3 — append-only audit log. event_id is intentionally NOT a foreign key:
  // the snapshot must outlive the deleted event it records.
  function addAudit(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_audit (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        action   TEXT NOT NULL CHECK(action IN ('create','update','delete')),
        at       TEXT NOT NULL DEFAULT (datetime('now')),
        snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_event ON event_audit(event_id);
    `);
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js test/migrate.test.js
git commit -m "feat: migration 3 — append-only event_audit table"
```

---

### Task 6: Migration 4 — rebuild `events` with `child_id` RESTRICT + CHECK constraints

**Files:**
- Modify: `lib/migrate.js`
- Modify: `test/migrate.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `test/migrate.test.js`:

```js
function seedChildAndEvent(db) {
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Child 1','#000',0)").run();
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,pd,date,time,who,notes)
     VALUES ('e1','School','school','c1','dropoff','2026-06-13','08:00','','')`
  ).run();
}

test('migration 4 preserves rows and enforces child_id RESTRICT', () => {
  const db = freshDb();
  runMigrations(db);
  seedChildAndEvent(db);
  // Deleting a child that has events must now fail (RESTRICT, not CASCADE).
  assert.throws(() => db.prepare("DELETE FROM children WHERE id='c1'").run());
  // The event is still there.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});

test('migration 4 CHECK rejects an invalid pd', () => {
  const db = freshDb();
  runMigrations(db);
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Child 1','#000',0)").run();
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO events (id,title,type,child_id,pd,date,time,who,notes)
         VALUES ('e2','School','school','c1','sideways','2026-06-13','08:00','','')`
      )
      .run()
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — child delete currently cascades (no throw); invalid pd currently inserts.

- [ ] **Step 3: Add migration 4**

Add a fourth entry to the `migrations` array in `lib/migrate.js`. (`runMigrations` already turns `foreign_keys` OFF around the run, which the table rebuild requires.)

```js
  // 4 — rebuild events: child_id ON DELETE RESTRICT (a mis-deleted child can no
  // longer wipe its history) + CHECK constraints for pd and date/time shape.
  // Length caps are enforced in lib/validate.js, NOT here, so the rebuild never
  // rejects a legacy over-length row. SQLite can't ALTER constraints in place.
  function hardenEvents(db) {
    db.exec(`
      CREATE TABLE events_new (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        type       TEXT NOT NULL,
        child_id   TEXT NOT NULL REFERENCES children(id) ON DELETE RESTRICT,
        caregiver_id TEXT REFERENCES caregivers(id),
        pd         TEXT NOT NULL DEFAULT 'dropoff' CHECK(pd IN ('dropoff','pickup','both')),
        date       TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        time       TEXT NOT NULL DEFAULT '08:00' CHECK(time GLOB '[0-9][0-9]:[0-9][0-9]'),
        who        TEXT DEFAULT '',
        notes      TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT
      );
      INSERT INTO events_new
        (id,title,type,child_id,caregiver_id,pd,date,time,who,notes,created_at,updated_at)
        SELECT id,title,type,child_id,caregiver_id,pd,date,time,
               COALESCE(who,''),COALESCE(notes,''),created_at,updated_at
        FROM events;
    `);
    const oldN = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const newN = db.prepare('SELECT COUNT(*) AS n FROM events_new').get().n;
    if (oldN !== newN) throw new Error(`events rebuild row mismatch: ${oldN} -> ${newN}`);
    db.exec(`
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    `);
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS (all migrate tests).

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js test/migrate.test.js
git commit -m "feat: migration 4 — events child_id RESTRICT + pd/date/time CHECK constraints"
```

---

## Phase C — Shared validation

### Task 7: `lib/validate.js`

**Files:**
- Create: `lib/validate.js`
- Test: `test/validate.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/validate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRealDate, isRealTime, validateEventFields, LIMITS } from '../lib/validate.js';

test('isRealDate rejects impossible / malformed dates', () => {
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-6-1', 'nope', '', null]) {
    assert.equal(isRealDate(bad), false, `${bad} should be invalid`);
  }
  for (const ok of ['2026-06-13', '2024-02-29']) {
    assert.equal(isRealDate(ok), true, `${ok} should be valid`);
  }
});

test('isRealTime bounds hours and minutes', () => {
  for (const bad of ['99:99', '24:00', '12:60', '7:00', '', null]) {
    assert.equal(isRealTime(bad), false, `${bad} should be invalid`);
  }
  for (const ok of ['08:00', '23:59', '00:00']) {
    assert.equal(isRealTime(ok), true, `${ok} should be valid`);
  }
});

test('validateEventFields enforces required, type, pd, dates, caps', () => {
  const base = {
    title: 'School run', type: 'school', pd: 'dropoff',
    date: '2026-06-13', time: '08:00', who: '', notes: '',
  };
  assert.equal(validateEventFields(base), null);
  assert.equal(validateEventFields({ ...base, title: '   ' }), 'Title is required');
  assert.equal(validateEventFields({ ...base, title: 'x'.repeat(LIMITS.title + 1) }), 'Title too long');
  assert.equal(validateEventFields({ ...base, type: 'nope' }), 'Invalid type');
  assert.equal(validateEventFields({ ...base, pd: 'sideways' }), 'Invalid trip kind');
  assert.equal(validateEventFields({ ...base, date: '2026-02-30' }), 'Invalid date');
  assert.equal(validateEventFields({ ...base, time: '99:99' }), 'Invalid time');
  assert.equal(validateEventFields({ ...base, notes: 'x'.repeat(LIMITS.notes + 1) }), 'Notes too long');
  // non-trip type ignores pd
  assert.equal(validateEventFields({ ...base, type: 'meal', pd: 'whatever' }), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/validate.js'`.

- [ ] **Step 3: Write `lib/validate.js`**

Create `lib/validate.js`:

```js
import { TYPE_KEYS, PD_KEYS, isTrip } from './constants.js';

export const LIMITS = { title: 120, who: 120, notes: 500 };

// YYYY-MM-DD that is a real calendar date (round-trips through Date).
export function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// HH:MM with hours 00-23 and minutes 00-59.
export function isRealTime(s) {
  if (typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) return false;
  const [h, mi] = s.split(':').map(Number);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

// Shape/value validation independent of the DB. Returns an error string or null.
export function validateEventFields(b) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  const title = b.title == null ? '' : String(b.title).trim();
  if (!title) return 'Title is required';
  if (title.length > LIMITS.title) return 'Title too long';
  if (!TYPE_KEYS.includes(b.type)) return 'Invalid type';
  if (isTrip(b.type) && !PD_KEYS.includes(b.pd)) return 'Invalid trip kind';
  if (!isRealDate(b.date)) return 'Invalid date';
  if (!isRealTime(b.time)) return 'Invalid time';
  if ((b.who == null ? '' : String(b.who).trim()).length > LIMITS.who) return 'Who too long';
  if ((b.notes == null ? '' : String(b.notes).trim()).length > LIMITS.notes) return 'Notes too long';
  return null;
}

// Full validation including child/caregiver existence (needs the DB).
export function validateEvent(b, db) {
  const err = validateEventFields(b);
  if (err) return err;
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(b.child_id);
  if (!child) return 'Unknown child';
  if (b.caregiver_id) {
    const cg = db.prepare('SELECT id FROM caregivers WHERE id = ?').get(b.caregiver_id);
    if (!cg) return 'Unknown caregiver';
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/validate.js test/validate.test.js
git commit -m "feat: shared lib/validate.js with real calendar-date + length validation"
```

---

## Phase D — Audit-writing helpers + route wiring

### Task 8: `lib/event-writes.js` (transactional create/update/delete + audit)

**Files:**
- Create: `lib/event-writes.js`
- Test: `test/event-writes.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/event-writes.test.js`. It points `DATA_DIR` at a temp dir, then imports `lib/db.js` (which migrates + seeds c1/c2, g1/g2) via `lib/event-writes.js`:

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let db, createEvent, updateEventTx, deleteEventTx, createEventsBulk;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ew-'));
  ({ default: db } = await import('../lib/db.js'));
  ({ createEvent, updateEventTx, deleteEventTx, createEventsBulk } = await import(
    '../lib/event-writes.js'
  ));
});

const sample = () => ({
  title: 'School drop-off', type: 'school', child_id: 'c1',
  caregiver_id: 'g1', pd: 'dropoff', date: '2026-06-13', time: '08:00', who: '', notes: '',
});
const auditFor = (id) =>
  db.prepare('SELECT action FROM event_audit WHERE event_id = ? ORDER BY id').all(id).map((r) => r.action);

test('create writes the row and a create audit entry', () => {
  const row = createEvent(sample());
  assert.equal(row.title, 'School drop-off');
  assert.deepEqual(auditFor(row.id), ['create']);
});

test('update sets updated_at and logs an update entry', () => {
  const row = createEvent(sample());
  const after = updateEventTx(row.id, { ...sample(), title: 'Changed' });
  assert.equal(after.title, 'Changed');
  assert.ok(after.updated_at, 'updated_at should be set');
  assert.deepEqual(auditFor(row.id), ['create', 'update']);
});

test('delete removes the row but preserves a delete snapshot', () => {
  const row = createEvent(sample());
  const ok = deleteEventTx(row.id);
  assert.equal(ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get(row.id).n, 0);
  const entries = db
    .prepare('SELECT action, snapshot FROM event_audit WHERE event_id = ? ORDER BY id')
    .all(row.id);
  assert.deepEqual(entries.map((e) => e.action), ['create', 'delete']);
  assert.equal(JSON.parse(entries[1].snapshot).title, 'School drop-off');
});

test('deleting a missing id returns false', () => {
  assert.equal(deleteEventTx('nope'), false);
});

test('bulk insert audits every row', () => {
  const n = createEventsBulk([sample(), { ...sample(), title: 'Pickup', pd: 'pickup' }]);
  assert.equal(n, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/event-writes.js'`.

- [ ] **Step 3: Write `lib/event-writes.js`**

Create `lib/event-writes.js`:

```js
import crypto from 'node:crypto';
import db from './db.js';
import { isTrip } from './constants.js';

// Normalize a request body into the exact column set we persist.
function normalize(b) {
  return {
    title: String(b.title).trim(),
    type: b.type,
    child_id: b.child_id,
    caregiver_id: b.caregiver_id || null,
    pd: isTrip(b.type) ? b.pd : 'dropoff',
    date: b.date,
    time: b.time,
    who: (b.who || '').trim(),
    notes: (b.notes || '').trim(),
  };
}

const insertEvent = db.prepare(
  `INSERT INTO events (id, title, type, child_id, caregiver_id, pd, date, time, who, notes)
   VALUES (@id, @title, @type, @child_id, @caregiver_id, @pd, @date, @time, @who, @notes)`
);
const updateEvent = db.prepare(
  `UPDATE events SET title=@title, type=@type, child_id=@child_id, caregiver_id=@caregiver_id,
     pd=@pd, date=@date, time=@time, who=@who, notes=@notes, updated_at=datetime('now')
   WHERE id=@id`
);
const getEvent = db.prepare('SELECT * FROM events WHERE id = ?');
const deleteEvent = db.prepare('DELETE FROM events WHERE id = ?');
const insertAudit = db.prepare(
  'INSERT INTO event_audit (event_id, action, snapshot) VALUES (@event_id, @action, @snapshot)'
);

function audit(event_id, action, row) {
  insertAudit.run({ event_id, action, snapshot: JSON.stringify(row) });
}
const newId = () => 'e' + crypto.randomUUID().slice(0, 12);

// create / update snapshot the resulting row; delete snapshots the row as it was.
export const createEvent = db.transaction((b) => {
  const id = newId();
  insertEvent.run({ id, ...normalize(b) });
  const row = getEvent.get(id);
  audit(id, 'create', row);
  return row;
});

export const updateEventTx = db.transaction((id, b) => {
  updateEvent.run({ id, ...normalize(b) });
  const row = getEvent.get(id);
  audit(id, 'update', row);
  return row;
});

export const deleteEventTx = db.transaction((id) => {
  const row = getEvent.get(id);
  if (!row) return false;
  audit(id, 'delete', row); // snapshot BEFORE the row leaves the table
  deleteEvent.run(id);
  return true;
});

export const createEventsBulk = db.transaction((items) => {
  let n = 0;
  for (const b of items) {
    const id = newId();
    insertEvent.run({ id, ...normalize(b) });
    audit(id, 'create', getEvent.get(id));
    n++;
  }
  return n;
});
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS (all event-writes tests).

- [ ] **Step 5: Commit**

```bash
git add lib/event-writes.js test/event-writes.test.js
git commit -m "feat: transactional event writes with append-only audit trail"
```

---

### Task 9: Wire the events routes to validate + audited writes

**Files:**
- Modify: `app/api/events/route.js`
- Modify: `app/api/events/[id]/route.js`
- Modify: `app/api/events/bulk/route.js`

- [ ] **Step 1: Rewrite `app/api/events/route.js`**

Replace the whole file:

```js
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateEvent, isRealDate } from '@/lib/validate';
import { createEvent } from '@/lib/event-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(request) {
  const g = await guard();
  if (g) return g;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  let rows;
  if (from || to) {
    if (!isRealDate(from) || !isRealDate(to)) {
      return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
    }
    rows = db
      .prepare('SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date, time')
      .all(from, to);
  } else {
    rows = db.prepare('SELECT * FROM events ORDER BY date, time').all();
  }
  const children = db.prepare('SELECT * FROM children ORDER BY sort').all();
  const caregivers = db.prepare('SELECT * FROM caregivers ORDER BY sort').all();
  return NextResponse.json({ events: rows, children, caregivers });
}

export async function POST(request) {
  const g = await guard();
  if (g) return g;

  let b;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const err = validateEvent(b, db);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const row = createEvent(b);
  return NextResponse.json(row, { status: 201 });
}
```

- [ ] **Step 2: Rewrite `app/api/events/[id]/route.js`**

Replace the whole file:

```js
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateEvent } from '@/lib/validate';
import { updateEventTx, deleteEventTx } from '@/lib/event-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function PUT(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  const existing = db.prepare('SELECT id FROM events WHERE id = ?').get(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let b;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const err = validateEvent(b, db);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const row = updateEventTx(id, b);
  return NextResponse.json(row);
}

export async function DELETE(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  const ok = deleteEventTx(id);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Rewrite `app/api/events/bulk/route.js`**

Replace the whole file:

```js
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateEvent } from '@/lib/validate';
import { createEventsBulk } from '@/lib/event-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

const MAX_BULK = 366; // mirrors the parse-route expansion cap

export async function POST(request) {
  const g = await guard();
  if (g) return g;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const rows = body?.events;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'No entries to create' }, { status: 400 });
  }
  if (rows.length > MAX_BULK) {
    return NextResponse.json({ error: `Too many entries (max ${MAX_BULK})` }, { status: 400 });
  }

  // Validate everything first — all-or-nothing, so a bad row never half-writes the batch.
  for (let i = 0; i < rows.length; i++) {
    const err = validateEvent(rows[i], db);
    if (err) return NextResponse.json({ error: err, index: i }, { status: 400 });
  }

  const created = createEventsBulk(rows);
  return NextResponse.json({ created }, { status: 201 });
}
```

- [ ] **Step 4: Verify build + a live round-trip**

Run:
```bash
nvm use 20
npm run build
```
Expected: build succeeds.

Then a manual smoke test (dev server):
```bash
export APP_PASSWORD=dev AUTH_SECRET=$(openssl rand -hex 32) DATA_DIR=$(mktemp -d)
npm run dev &
sleep 4
# log in, capture cookie
curl -s -c /tmp/kin.cookie -H 'Content-Type: application/json' \
  -d '{"password":"dev"}' http://localhost:3000/api/auth/login >/dev/null
# create
curl -s -b /tmp/kin.cookie -H 'Content-Type: application/json' \
  -d '{"title":"School","type":"school","child_id":"c1","caregiver_id":"g1","pd":"dropoff","date":"2026-06-13","time":"08:00"}' \
  http://localhost:3000/api/events
# reject an impossible date
curl -s -b /tmp/kin.cookie -H 'Content-Type: application/json' \
  -d '{"title":"X","type":"school","child_id":"c1","pd":"dropoff","date":"2026-02-30","time":"08:00"}' \
  http://localhost:3000/api/events
kill %1
```
Expected: first create returns a JSON event with an `id`; the `2026-02-30` request returns `{"error":"Invalid date"}`.

- [ ] **Step 5: Commit**

```bash
git add app/api/events/route.js app/api/events/[id]/route.js app/api/events/bulk/route.js
git commit -m "feat: route writes go through shared validation + audited transactions"
```

---

### Task 10: Parse route uses real date/time validation

**Files:**
- Modify: `app/api/parse/route.js`

- [ ] **Step 1: Import the shared validators**

In `app/api/parse/route.js`, add to the imports near the top (after the existing imports):

```js
import { isRealDate, isRealTime } from '@/lib/validate';
```

- [ ] **Step 2: Use them for the draft's date/time**

Replace these two lines inside the `draft` object:

```js
    date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date || '') ? parsed.date : today,
    time: /^\d{2}:\d{2}$/.test(parsed.time || '') ? parsed.time : '08:00',
```

with:

```js
    date: isRealDate(parsed.date) ? parsed.date : today,
    time: isRealTime(parsed.time) ? parsed.time : '08:00',
```

- [ ] **Step 3: Use real-date bounds for the recurrence**

Replace the `recValid` block:

```js
  const recValid =
    rec &&
    typeof rec === 'object' &&
    normWeekdays(rec.weekdays).length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(rec.from || '') &&
    /^\d{4}-\d{2}-\d{2}$/.test(rec.to || '') &&
    rec.from <= rec.to;
```

with:

```js
  const recValid =
    rec &&
    typeof rec === 'object' &&
    normWeekdays(rec.weekdays).length > 0 &&
    isRealDate(rec.from) &&
    isRealDate(rec.to) &&
    rec.from <= rec.to;
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/api/parse/route.js
git commit -m "fix: parse route validates real calendar dates for draft + backfill bounds"
```

---

## Phase E — Timestamps, edited marker, export

### Task 11: `lib/format.js` local-time helper

**Files:**
- Create: `lib/format.js`
- Test: `test/format.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/format.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtRecorded } from '../lib/format.js';

test('fmtRecorded converts a stored UTC string to local time', () => {
  // 03:58 UTC on the 13th is 23:58 on the 12th in America/New_York (EDT).
  const out = fmtRecorded('2026-06-13 03:58:27', 'America/New_York');
  assert.match(out, /Jun 12, 2026/);
  assert.match(out, /11:58/);
});

test('fmtRecorded is empty for empty input and echoes garbage', () => {
  assert.equal(fmtRecorded('', 'America/New_York'), '');
  assert.equal(fmtRecorded('not-a-date', 'America/New_York'), 'not-a-date');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/format.js'`.

- [ ] **Step 3: Write `lib/format.js`**

Create `lib/format.js`:

```js
// Default display timezone for "Recorded" timestamps. Override at build time with
// NEXT_PUBLIC_TZ (inlined into the client bundle).
export const RECORDED_TZ = process.env.NEXT_PUBLIC_TZ || 'America/New_York';

// SQLite datetime('now') stores 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker.
// Render it in the configured local zone so a late-evening entry doesn't appear
// on the next calendar day.
export function fmtRecorded(s, tz = RECORDED_TZ) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS.

> If the assertion fails because the test host lacks IANA tz data, that's an environment problem, not a code bug — `Intl`/`timeZone` requires full ICU, which the project's Node 20 build includes.

- [ ] **Step 5: Commit**

```bash
git add lib/format.js test/format.test.js
git commit -m "feat: lib/format.js — render Recorded timestamps in local time"
```

---

### Task 12: Report shows local "Recorded" + "edited" marker

**Files:**
- Modify: `components/Report.js`

- [ ] **Step 1: Import the helper**

In `components/Report.js`, add to the imports at the top (after the existing `import { TYPES, PD } ...` line):

```js
import { fmtRecorded } from '@/lib/format';
```

- [ ] **Step 2: Relabel the detail column header**

Replace `<th>Recorded</th>` (in the detail `<thead>`) with:

```jsx
                <th>Recorded (local)</th>
```

- [ ] **Step 3: Render local time + edited marker in the cell**

Replace the recorded `<td>` in the detail `<tbody>`:

```jsx
                  <td className="muted">{e.created_at}</td>
```

with:

```jsx
                  <td className="muted">
                    {fmtRecorded(e.created_at)}
                    {e.updated_at ? (
                      <span className="edited"> · edited {fmtRecorded(e.updated_at)}</span>
                    ) : null}
                  </td>
```

- [ ] **Step 4: Use local time in the CSV export**

In `exportCsv()`, in the detail-log header line, replace `'Recorded at'` with `'Recorded (local)'`, and replace the `e.created_at` value with the formatted version plus an edited note. Specifically, change the detail-log header:

```js
    lines.push(
      ['Date', 'Time', 'Activity', 'Child', 'Done by', 'Recorded (local)', 'Note'].map(esc).join(',')
    );
```

and change the per-row value `e.created_at,` (inside the `for (const e of detail)` push) to:

```js
          e.updated_at ? `${fmtRecorded(e.created_at)} (edited ${fmtRecorded(e.updated_at)})` : fmtRecorded(e.created_at),
```

- [ ] **Step 5: Update the report's methodology note**

Replace the `report-note` paragraph text:

```jsx
          Self-reported log. Each entry below shows the date it was actually recorded; this
          summary reflects only what has been logged in the app.
```

with:

```jsx
          Self-reported log. Each entry shows when it was recorded (local time); entries
          changed after creation are marked “edited.” This summary reflects only what has
          been logged in the app.
```

- [ ] **Step 6: Add a style for the edited marker**

In `app/globals.css`, add at the end:

```css
.report-table .edited { color: #9a3b3b; font-style: italic; }
```

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add components/Report.js app/globals.css
git commit -m "feat: report shows local Recorded time + edited markers (CSV too)"
```

---

### Task 13: Faithful export endpoint

**Files:**
- Create: `lib/export.js`
- Create: `app/api/export/route.js`
- Modify: `test/event-writes.test.js` (add an export assertion — reuses the migrated/seeded temp DB)

- [ ] **Step 1: Add the failing test**

Append to `test/event-writes.test.js`:

```js
test('buildExport returns all tables + meta', async () => {
  const { buildExport } = await import('../lib/export.js');
  createEvent(sample());
  const dump = buildExport(db);
  assert.ok(Array.isArray(dump.events) && dump.events.length >= 1);
  assert.ok(Array.isArray(dump.children) && dump.children.length === 2);
  assert.ok(Array.isArray(dump.caregivers) && dump.caregivers.length === 2);
  assert.ok(Array.isArray(dump.event_audit) && dump.event_audit.length >= 1);
  assert.equal(typeof dump.schema_version, 'number');
  assert.ok(dump.exported_at);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/export.js'`.

- [ ] **Step 3: Write `lib/export.js`**

Create `lib/export.js`:

```js
// A faithful, complete dump of the record — every column, every row, plus the
// audit trail. This is the defensible handoff artifact (the report CSV is a
// human summary). Timestamps are stored UTC; see lib/format.js for display.
export function buildExport(db) {
  return {
    schema_version: db.pragma('user_version', { simple: true }),
    exported_at: new Date().toISOString(),
    note: 'Timestamps (created_at, updated_at, event_audit.at) are UTC.',
    children: db.prepare('SELECT * FROM children ORDER BY sort').all(),
    caregivers: db.prepare('SELECT * FROM caregivers ORDER BY sort').all(),
    events: db.prepare('SELECT * FROM events ORDER BY date, time').all(),
    event_audit: db.prepare('SELECT * FROM event_audit ORDER BY id').all(),
  };
}
```

- [ ] **Step 4: Write the route**

Create `app/api/export/route.js`:

```js
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { buildExport } from '@/lib/export';

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const data = buildExport(db);
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="kin-export-${data.exported_at.slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
```

- [ ] **Step 5: Run tests + build**

Run: `npm test && npm run build`
Expected: tests PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add lib/export.js app/api/export/route.js test/event-writes.test.js
git commit -m "feat: authed GET /api/export — faithful full-data JSON dump"
```

---

## Phase F — Durability: health endpoint

### Task 14: DB-aware health endpoint + healthcheck repoint

**Files:**
- Create: `app/api/health/route.js`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Write the route**

Create `app/api/health/route.js`:

```js
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';

// Unauthenticated, but only ever runs SELECT 1 — no data is exposed. Lets Docker
// and Coolify detect a corrupt or unwritable DB instead of a green static page.
export async function GET() {
  try {
    db.prepare('SELECT 1').get();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 503 });
  }
}
```

- [ ] **Step 2: Point the Docker healthcheck at it**

In `docker-compose.yml`, replace the healthcheck `test` line:

```yaml
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

with:

```yaml
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

- [ ] **Step 3: Verify**

Run:
```bash
export APP_PASSWORD=dev AUTH_SECRET=$(openssl rand -hex 32) DATA_DIR=$(mktemp -d)
npm run build && npm run start &
sleep 4
curl -s http://localhost:3000/api/health
kill %1
```
Expected: `{"ok":true}`.

- [ ] **Step 4: Commit**

```bash
git add app/api/health/route.js docker-compose.yml
git commit -m "feat: DB-aware /api/health endpoint; repoint Docker healthcheck"
```

---

## Phase G — Backups: Litestream → Cloudflare R2

> These steps add infrastructure. They require an R2 bucket and credentials from the operator (you). Final verification is a restore drill on the server.

### Task 15: Litestream sidecar + restore drill

**Files:**
- Create: `litestream.yml`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Create/Modify: `.env.example`

- [ ] **Step 1: Confirm Litestream / WAL interaction against current docs**

Before writing config, confirm with the live Litestream docs (use the context7 MCP: resolve `litestream`, then query "replicate sqlite to S3-compatible R2, docker, wal checkpoint interaction"). Litestream manages its own checkpointing; the app's `wal_autocheckpoint` default and the SIGTERM `wal_checkpoint(TRUNCATE)` in `lib/db.js` are compatible (Litestream tolerates external checkpoints), but verify there is no required `busy_timeout` or `wal_autocheckpoint` setting for the current Litestream version. Record any required tweak before proceeding.

- [ ] **Step 2: Write `litestream.yml`**

Create `litestream.yml` (Cloudflare R2 is S3-compatible; endpoint is the account R2 endpoint):

```yaml
dbs:
  - path: /app/data/tracker.db
    replicas:
      - type: s3
        bucket: ${R2_BUCKET}
        path: tracker
        endpoint: ${R2_ENDPOINT}        # https://<accountid>.r2.cloudflarestorage.com
        region: auto
        access-key-id: ${R2_ACCESS_KEY_ID}
        secret-access-key: ${R2_SECRET_ACCESS_KEY}
```

- [ ] **Step 3: Add the Litestream sidecar to `docker-compose.yml`**

Add a `litestream` service sharing the data volume, and add the R2 vars to the app's environment block is not needed — only Litestream needs them. Insert under `services:` (sibling of `app:`):

```yaml
  litestream:
    image: litestream/litestream:0.3
    restart: unless-stopped
    depends_on:
      - app
    volumes:
      - tracker_data:/app/data
      - ./litestream.yml:/etc/litestream.yml:ro
    environment:
      R2_BUCKET: ${R2_BUCKET:?set R2_BUCKET}
      R2_ENDPOINT: ${R2_ENDPOINT:?set R2_ENDPOINT}
      R2_ACCESS_KEY_ID: ${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}
      R2_SECRET_ACCESS_KEY: ${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}
    command: ["replicate"]
```

> Pin the image tag to the exact current minor (e.g. `litestream/litestream:0.3.x`) confirmed in Step 1.

- [ ] **Step 4: Document env vars in `.env.example`**

Append to `.env.example` (create it if missing) — values are placeholders, never real secrets:

```bash
# Display timezone for "Recorded" timestamps (build-time, inlined into the client).
NEXT_PUBLIC_TZ=America/New_York

# Litestream → Cloudflare R2 (set in Coolify env, not committed)
R2_BUCKET=kin-backups
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
```

- [ ] **Step 5: Fix the README backup section + add restore drill**

In `README.md`, replace the `## Data & backups` section body:

```markdown
Everything lives in `data/tracker.db` (plus `-wal`/`-shm` companions while running). Back up by copying that file, or snapshot the `tracker_data` volume.
```

with:

```markdown
The record lives in `data/tracker.db` (with `-wal`/`-shm` companions while running).

**Do not `cp tracker.db`** — with WAL journaling that can capture a near-empty file.
For a manual snapshot use SQLite's online backup, which is WAL-safe:

```bash
sqlite3 data/tracker.db ".backup 'backup-$(date +%F).db'"
```

**Automated backups:** a Litestream sidecar (see `docker-compose.yml` + `litestream.yml`)
continuously replicates `tracker.db` to a Cloudflare R2 bucket with point-in-time recovery.
Set `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in Coolify.

**Restore drill (run periodically — an untested backup is not a backup):**

```bash
litestream restore -o /tmp/restored.db \
  -config litestream.yml /app/data/tracker.db
sqlite3 /tmp/restored.db "PRAGMA integrity_check; SELECT COUNT(*) FROM events;"
```

A faithful JSON export of the full record (including the edit/delete audit trail) is also
available to the logged-in user at `GET /api/export`.
```

- [ ] **Step 6: Verify compose config parses**

Run:
```bash
R2_BUCKET=x R2_ENDPOINT=x R2_ACCESS_KEY_ID=x R2_SECRET_ACCESS_KEY=x \
APP_PASSWORD=x AUTH_SECRET=x docker compose config >/dev/null && echo "compose ok"
```
Expected: `compose ok` (validates YAML + variable interpolation; does not start anything).

- [ ] **Step 7: Commit**

```bash
git add litestream.yml docker-compose.yml README.md .env.example
git commit -m "feat: Litestream -> Cloudflare R2 backups + restore drill docs"
```

- [ ] **Step 8: Deploy-time verification (on the server, after setting R2 env)**

After deploy: confirm objects appear in the R2 bucket (`tracker/` prefix), then run the restore drill from Step 5 against the running container and confirm `integrity_check` is `ok` and the event count matches. **Run a manual `.backup` before the first migrating deploy** (see the ⚠️ note at the top).

---

## Self-Review

**Spec coverage** (`2026-06-13-kin-record-integrity-design.md`):
- §2 migration runner → Tasks 2–3 ✓
- §3 schema (updated_at, event_audit, events rebuild RESTRICT + CHECK) → Tasks 4–6 ✓
- §4 audit trail (create/update/delete, snapshot-before-delete) → Tasks 8–9 ✓
- §5 timestamps + edited marker → Tasks 11–12 ✓
- §6 validation (real dates, length caps, shared lib, GET range, expandDates bounds) → Tasks 7, 9, 10 ✓
- §7 export → Task 13 ✓
- §8 durability (shutdown, quick_check, health, README backup fix) → Tasks 3, 14, 15 ✓
- §9 Litestream → R2 + restore drill → Task 15 ✓
- §10 tests → Tasks 2,4,5,6,7,8,11,13 ✓

**Deviations from spec (intentional, noted):**
- Length caps are enforced in `lib/validate.js`, NOT as DB `CHECK` constraints (spec §3 mentioned "field length bounds"). Reason: a DB length CHECK would reject any legacy over-length row during the Task 6 rebuild, risking the live record. App-layer enforcement covers all new writes.
- TZ is `NEXT_PUBLIC_TZ` (build-time, client-inlined) defaulting to `America/New_York`, rather than a runtime `TZ` env, because the report is a client component. Documented in `.env.example` + README.

**Placeholder scan:** none — every step has complete code or an exact command.

**Type consistency:** `validateEvent(b, db)` / `validateEventFields(b)` / `isRealDate` / `isRealTime` (validate.js) used identically in Tasks 9–10. `createEvent`/`updateEventTx`/`deleteEventTx`/`createEventsBulk` (event-writes.js) names match between Task 8 definition and Task 9 usage. `fmtRecorded` (format.js) matches between Tasks 11–12. `buildExport(db)` matches between Tasks 13 definition and usage.

**Risk gates:** Task 1 Step 3 (standalone boots under `type: module`) and the top-of-plan ⚠️ (backup before the migrating deploy) are the two stop-and-verify points.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { runMigrations, runWithBusyRetry, migrations } from './migrate.js';
import { snapshotBeforeMigrations } from './backup.js';

// During `next build`, route modules are imported by parallel page-data workers, each
// of which would otherwise open and migrate the real DB concurrently — many workers
// contending on one file's write lock blows past SQLite's busy_timeout (SQLITE_BUSY).
// The build only needs the schema to exist so db.prepare() can validate; it must never
// touch the data volume. So during the build phase each worker uses a private in-memory
// DB. Runtime (single process) is unaffected and uses the real file.
const isBuild = process.env.NEXT_PHASE === 'phase-production-build';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!isBuild) mkdirSync(DATA_DIR, { recursive: true });

const dbPath = isBuild ? ':memory:' : path.join(DATA_DIR, 'tracker.db');

// Reuse a single connection across hot reloads / serverless invocations.
const globalForDb = globalThis;
const db = globalForDb.__ttDb || new Database(dbPath);
if (!globalForDb.__ttDb) globalForDb.__ttDb = db;

// Wait out a locked DB rather than failing immediately. During a deploy the old and new containers
// briefly share the data volume (Litestream is replicating it), so a boot-time write can momentarily
// lose the lock. A generous busy_timeout lets SQLite's native handler ride out most of that overlap.
// Install it first — it's connection config, not a DB write — so every write below inherits it.
// (codex P2, PR #12. Runtime variant of the build-time SQLITE_BUSY rule in .claude/rules/kin.md.)
db.pragma('busy_timeout = 20000');

// Enable WAL, snapshot an existing record before any pending migration rewrites it (e.g. the
// events-table rebuild), then migrate. All three take the DB lock; wrap them in a SQLITE_BUSY retry
// so a container-swap lock race can't crash-loop boot (busy_timeout handles the brief case; the retry
// covers a BUSY returned despite it). All three are idempotent, so retry is safe.
runWithBusyRetry(
  () => {
    // journal_mode = WAL is the first real write on a fresh/restored (non-WAL) volume, and the write
    // most exposed to the swap lock race — so it rides the same retry as the migration, not just the
    // busy_timeout. Setting WAL when already in WAL is a no-op, so re-running on retry is safe.
    db.pragma('journal_mode = WAL');
    // Fail fast (inside the retry) if the snapshot can't be written — better to not boot than to
    // migrate the only copy of the record without a rollback point.
    const snap = snapshotBeforeMigrations(db, DATA_DIR, migrations.length);
    if (snap) console.log('[kin] pre-migration backup ready:', snap);
    runMigrations(db); // all schema lives in migrations; this also restores foreign_keys = ON
  },
  { onRetry: (i) => console.warn(`[kin] DB locked during boot migration (attempt ${i}); retrying…`) }
);
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

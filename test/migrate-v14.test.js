import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, migrations } from '../lib/migrate.js';
import { sealMonth, verifySeal } from '../lib/seal.js';

// v14 rebuilds `events` to widen the pd CHECK with 'none'. A rebuild of the legal-record table is
// the one migration shape that can silently corrupt history: lib/seal.js seals pd/created_at/
// updated_at RAW, so a fired DEFAULT or a stray COALESCE invalidates every prior month seal with no
// error anywhere. These tests are therefore machine-derived (pragma snapshots, SELECT *) rather than
// hand-enumerated column lists — a hand list shares the DDL author's blind spots.

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

// A v13 database with the family roster seeded, ready for fixture events.
function v13Db() {
  const db = new Database(':memory:');
  runMigrations(db, migrations.slice(0, 13));
  assert.equal(db.pragma('user_version', { simple: true }), 13);
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Ivy','#000000',0)").run();
  db.prepare("INSERT INTO caregivers (id,name,color,sort) VALUES ('g1','Dad','#111111',0)").run();
  db.prepare("INSERT INTO caregivers (id,name,color,sort) VALUES ('g2','Mom','#222222',1)").run();
  return db;
}

test('migrations include v14 and a fresh DB reaches it', () => {
  assert.ok(migrations.length >= 14);
  const db = freshDb();
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  db.close();
});

test('the widened pd CHECK accepts none, still rejects garbage, and still defaults to dropoff', () => {
  const db = freshDb();
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Ivy','#000000',0)").run();
  const ins = (id, pd) =>
    db
      .prepare('INSERT INTO events (id,title,type,child_id,pd,date,time) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'Digital learning day', 'school', 'c1', pd, '2026-08-13', '08:00');

  ins('e1', 'none');
  assert.equal(db.prepare("SELECT pd FROM events WHERE id='e1'").get().pd, 'none');
  assert.throws(() => ins('e2', 'sideways'), /CHECK/);
  // The filler default is load-bearing (lib/event-writes.js coerces every non-trip row to it).
  db.prepare(
    "INSERT INTO events (id,title,type,child_id,date,time) VALUES ('e3','Dinner','meal','c1','2026-08-13','18:00')"
  ).run();
  assert.equal(db.prepare("SELECT pd FROM events WHERE id='e3'").get().pd, 'dropoff');
  db.close();
});

test('the rebuild preserves the events column shape exactly (name-keyed, not positional)', () => {
  // Keyed by NAME so a reordering is not a false failure, and compared whole so a lost NOT NULL, a
  // lost DEFAULT or a lost PRIMARY KEY fails — none of which the row-count guard or
  // foreign_key_check can see. CHECK constraints don't appear in table_info, so widening pd's is
  // invisible here by design; test/migrate-v14 asserts that behaviourally above.
  const before = v13Db();
  const shape = (db) =>
    Object.fromEntries(
      db
        .prepare('PRAGMA table_info(events)')
        .all()
        .map((c) => [c.name, { type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }])
    );
  const v13Shape = shape(before);
  runMigrations(before);
  const v14Shape = shape(before);

  assert.deepEqual(Object.keys(v14Shape).sort(), Object.keys(v13Shape).sort());
  assert.equal(Object.keys(v14Shape).length, 17);
  assert.deepEqual(v14Shape, v13Shape);
  before.close();
});

test('the rebuild preserves every foreign-key DECLARATION on events', () => {
  // foreign_key_check cannot substitute for this: it reports dangling rows, and is blind to a
  // declaration that was simply dropped from the new DDL.
  const db = freshDb();
  const fks = db
    .prepare('PRAGMA foreign_key_list(events)')
    .all()
    .map((f) => ({ from: f.from, table: f.table, to: f.to, on_delete: f.on_delete }))
    .sort((a, b) => a.from.localeCompare(b.from));
  assert.deepEqual(fks, [
    { from: 'caregiver_id', table: 'caregivers', to: 'id', on_delete: 'NO ACTION' },
    { from: 'child_id', table: 'children', to: 'id', on_delete: 'RESTRICT' },
    { from: 'pickup_caregiver_id', table: 'caregivers', to: 'id', on_delete: 'NO ACTION' },
  ]);
  db.close();
});

test('the rebuild recreates every index DROP TABLE destroyed', () => {
  // Nothing else in the suite asserts idx_events_date or idx_events_series exist, so losing either
  // in a rebuild would be completely silent. sqlite_autoindex_events_1 proves the PRIMARY KEY survived.
  const db = freshDb();
  const names = db.prepare('PRAGMA index_list(events)').all().map((r) => r.name);
  for (const idx of ['idx_events_date', 'idx_events_series', 'idx_events_ical', 'sqlite_autoindex_events_1']) {
    assert.ok(names.includes(idx), `missing index ${idx}`);
  }
  // The dedup index must stay the FOUR-column v13 form; the v12 three-column version silently
  // collapses both kids' same-day occurrence onto one dedup key.
  assert.deepEqual(
    db.prepare('PRAGMA index_info(idx_events_ical)').all().map((r) => r.name),
    ['subscription_id', 'ical_uid', 'date', 'ical_key']
  );
  db.close();
});

test('the rebuild carries every v13 row through byte-identically', () => {
  const db = v13Db();
  // Explicit historical created_at / updated_at: datetime('now') has 1-SECOND resolution, so a
  // fixture inserted and migrated within the same second would get a rewritten created_at that is
  // byte-identical anyway — and this test would pass with the bug present.
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,caregiver_id,pickup_caregiver_id,pd,date,time,who,notes,created_at,updated_at,series_id)
     VALUES ('e1','Swim','sport','c1','g1','g2','both','2026-08-15','10:30','Coach','bring goggles','2026-01-02 03:04:05','2026-02-03 04:05:06','ser1')`
  ).run();
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,caregiver_id,pd,date,time,created_at,subscription_id,ical_uid,ical_key)
     VALUES ('e2','Minnows','sport','c1','g1','dropoff','2026-08-16','09:00','2026-01-02 03:04:05','sub1','u1','ivy')`
  ).run();
  // A non-trip row carrying the inert filler — the rows the forbidden cleanup UPDATE would touch.
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,caregiver_id,pd,date,time,created_at)
     VALUES ('e3','Dinner','meal','c1','g2','dropoff','2026-08-15','18:00','2026-01-02 03:04:05')`
  ).run();
  // NULL who/notes, to prove no COALESCE crept into the copy (migration 4's rebuild had one).
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,pd,date,time,who,notes,created_at)
     VALUES ('e4','Ortho','ortho','c1','pickup','2026-08-17','14:00',NULL,NULL,'2026-01-02 03:04:05')`
  ).run();

  const before = db.prepare('SELECT * FROM events ORDER BY id').all();
  runMigrations(db);
  const after = db.prepare('SELECT * FROM events ORDER BY id').all();

  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  assert.deepEqual(after, before); // key-order-insensitive, and no column list to forget
  assert.equal(after.find((r) => r.id === 'e4').who, null);
  db.close();
});

test('a month sealed under v13 still verifies after the rebuild', () => {
  // The production invariant, end to end: the seal covers pd/created_at/updated_at raw, so this
  // fails the moment the rebuild rewrites any of them.
  const SECRET = 'test-secret-at-least-16-chars';
  const db = v13Db();
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,caregiver_id,pd,date,time,who,notes,created_at,updated_at)
     VALUES ('e1','School run','school','c1','g1','dropoff','2026-08-03','08:00','','','2026-01-02 03:04:05','2026-02-03 04:05:06')`
  ).run();
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,caregiver_id,pd,date,time,created_at)
     VALUES ('e2','Dinner','meal','c1','g2','dropoff','2026-08-03','18:00','2026-01-02 03:04:05')`
  ).run();

  const events = db.prepare('SELECT * FROM events').all();
  // A schedule so the `nights` half of the canonical string is exercised too.
  const schedules = [
    { id: 's1', preset: 'week_about', cycle_len: 14, assignment: JSON.stringify(Array(14).fill('g1')), start_date: '2026-01-01', end_date: null },
  ];
  const sealed = sealMonth('2026-08', events, schedules, [], SECRET);

  runMigrations(db); // apply v14

  const fresh = db.prepare('SELECT * FROM events').all();
  const check = verifySeal({ month: '2026-08', ...sealed }, fresh, schedules, [], SECRET);
  assert.equal(check.match, true, 'the rebuild changed a sealed value');
  assert.equal(check.event_count, 2);
  db.close();
});

test('the column pre-flight guard aborts the rebuild and rolls back', () => {
  const db = v13Db();
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,pd,date,time,created_at)
     VALUES ('e1','School run','school','c1','dropoff','2026-08-03','08:00','2026-01-02 03:04:05')`
  ).run();
  // Simulate a later migration having added a column that migration 14's list doesn't know about.
  db.exec('ALTER TABLE events ADD COLUMN future_col TEXT');

  assert.throws(() => runMigrations(db), /would drop column\(s\): future_col/);
  // The pre-flight runs before any DDL, so nothing was attempted — no events_new, no DROP. The
  // runner's transaction is what keeps user_version from advancing past the throw.
  assert.equal(db.pragma('user_version', { simple: true }), 13);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  assert.ok(db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'future_col'));
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='events_new'").get().n,
    0
  );
  db.close();
});

// The two guards BELOW the pre-flight are the ones that actually protect month seals, and neither
// fires on any well-formed input — so without these tests, deleting either leaves the suite green.
// Both drive the real migration function and corrupt only its copy statement, which is exactly the
// class of mistake they exist to catch (a rebuild that quietly rewrites or loses a row).
function withMutatedCopy(db, mutate) {
  const realExec = db.exec.bind(db);
  db.exec = (sql) => {
    if (!sql.includes('INSERT INTO events_new')) return realExec(sql);
    const i = sql.indexOf('SELECT id'); // mutate the SELECT list only, never the column list
    return realExec(sql.slice(0, i) + mutate(sql.slice(i)));
  };
}

test('the drift guard aborts a rebuild that rewrites a sealed column', () => {
  const db = v13Db();
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,pd,date,time,created_at)
     VALUES ('e1','School run','school','c1','dropoff','2026-08-03','08:00','2026-01-02 03:04:05')`
  ).run();
  // Stand in for a fired DEFAULT / stray COALESCE: the copy silently changes a sealed value.
  withMutatedCopy(db, (select) => select.replace(',title,', ",'MUTATED',"));

  assert.throws(() => migrations[13](db), /altered 1 row\(s\).*seal safety/);
  // It threw BEFORE the DROP, so the real table is still there and still correct.
  assert.equal(db.prepare("SELECT title FROM events WHERE id='e1'").get().title, 'School run');
  db.close();
});

test('the row-count guard aborts a rebuild that drops a row', () => {
  const db = v13Db();
  for (const id of ['e1', 'e2']) {
    db.prepare(
      `INSERT INTO events (id,title,type,child_id,pd,date,time,created_at)
       VALUES (?,'School run','school','c1','dropoff','2026-08-03','08:00','2026-01-02 03:04:05')`
    ).run(id);
  }
  withMutatedCopy(db, (select) => select.replace('FROM events', "FROM events WHERE id <> 'e1'"));

  assert.throws(() => migrations[13](db), /row mismatch: 2 -> 1/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
  db.close();
});

test('v14 leaves no foreign-key violations on a fresh DB', () => {
  const db = freshDb();
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});

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

test('a failing migration rolls back and leaves user_version unchanged', () => {
  const db = freshDb();
  const boom = [
    (d) => d.exec('CREATE TABLE a (id TEXT)'),
    (d) => { d.exec('CREATE TABLE b (id TEXT)'); throw new Error('boom'); },
  ];
  assert.throws(() => runMigrations(db, boom));
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('a'));
  assert.ok(!tables.includes('b'));
});

test('a migration that introduces a dangling foreign key is rejected and rolled back', () => {
  const db = freshDb();
  const migs = [
    migrations[0], // baseline creates children + events
    (d) => d.prepare(
      "INSERT INTO events (id,title,type,child_id,pd,date,time) VALUES ('e1','x','school','ghost','dropoff','2026-01-01','08:00')"
    ).run(),
  ];
  assert.throws(() => runMigrations(db, migs), /foreign-key/i);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
});

test('migration adds updated_at column', () => {
  const db = freshDb();
  runMigrations(db);
  assert.ok(cols(db, 'events').includes('updated_at'));
});

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

function seedChildAndEvent(db) {
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Ivy','#000',0)").run();
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
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Ivy','#000',0)").run();
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO events (id,title,type,child_id,pd,date,time,who,notes)
         VALUES ('e2','School','school','c1','sideways','2026-06-13','08:00','','')`
      )
      .run()
  );
});

test('migration 4 preserves column values and coalesces legacy NULL who/notes', () => {
  const db = freshDb();
  // Apply only migrations 1-3, then insert a legacy row with explicit NULL who/notes.
  runMigrations(db, migrations.slice(0, 3));
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Ivy','#000',0)").run();
  db.prepare("INSERT INTO caregivers (id,name,color,sort) VALUES ('g1','Dad','#111',0)").run();
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,caregiver_id,pd,date,time,who,notes,created_at)
     VALUES ('e1','Dinner','meal','c1','g1','dropoff','2026-06-13','18:30',NULL,NULL,'2026-06-13 22:30:00')`
  ).run();
  // Now apply migration 4 (the rebuild).
  runMigrations(db);
  const row = db.prepare("SELECT * FROM events WHERE id='e1'").get();
  assert.equal(row.title, 'Dinner');
  assert.equal(row.caregiver_id, 'g1');
  assert.equal(row.created_at, '2026-06-13 22:30:00');
  assert.equal(row.who, '');   // legacy NULL -> ''
  assert.equal(row.notes, ''); // legacy NULL -> ''
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});

test('migration 4 CHECK rejects malformed date and time', () => {
  const db = freshDb();
  runMigrations(db);
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Ivy','#000',0)").run();
  assert.throws(() => db.prepare(
    "INSERT INTO events (id,title,type,child_id,pd,date,time,who,notes) VALUES ('e3','S','school','c1','dropoff','2026-6-1','08:00','','')"
  ).run());
  assert.throws(() => db.prepare(
    "INSERT INTO events (id,title,type,child_id,pd,date,time,who,notes) VALUES ('e4','S','school','c1','dropoff','2026-06-13','8:0','','')"
  ).run());
});

test('baseline repairs an orphaned caregiver_id so the FK gate does not brick startup', () => {
  const db = freshDb();
  // Hand-build a pre-versioning (user_version=0) DB with an event whose caregiver_id
  // points at a caregiver that does not exist. foreign_keys OFF so we can create it.
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE children (id TEXT PRIMARY KEY, name TEXT, color TEXT, sort INTEGER);
    CREATE TABLE caregivers (id TEXT PRIMARY KEY, name TEXT, color TEXT, sort INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT, type TEXT, child_id TEXT,
      pd TEXT, date TEXT, time TEXT, who TEXT, notes TEXT, created_at TEXT, caregiver_id TEXT);
  `);
  db.prepare("INSERT INTO children VALUES ('c1','Ivy','#000',0)").run();
  db.prepare(
    "INSERT INTO events (id,title,type,child_id,pd,date,time,who,notes,created_at,caregiver_id) " +
    "VALUES ('e1','School','school','c1','dropoff','2026-01-01','08:00','','','2026-01-01 12:00:00','ghost')"
  ).run();
  // user_version is still 0, so runMigrations applies baseline (with repair) → 4.
  assert.doesNotThrow(() => runMigrations(db));
  assert.equal(db.prepare("SELECT caregiver_id FROM events WHERE id='e1'").get().caregiver_id, null);
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
});

test('baseline fails with a clear message on an orphaned child_id (no silent repair)', () => {
  const db = freshDb();
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE children (id TEXT PRIMARY KEY, name TEXT, color TEXT, sort INTEGER);
    CREATE TABLE caregivers (id TEXT PRIMARY KEY, name TEXT, color TEXT, sort INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT, type TEXT, child_id TEXT,
      pd TEXT, date TEXT, time TEXT, who TEXT, notes TEXT, created_at TEXT, caregiver_id TEXT);
  `);
  db.prepare(
    "INSERT INTO events (id,title,type,child_id,pd,date,time,who,notes,created_at) " +
    "VALUES ('e1','x','school','ghostchild','dropoff','2026-01-01','08:00','','','2026-01-01 12:00:00')"
  ).run();
  assert.throws(() => runMigrations(db), /missing child_id/i);
  assert.equal(db.pragma('user_version', { simple: true }), 0); // nothing applied
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, migrations } from '../lib/migrate.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

// A bare :memory: migration creates tables but doesn't seed children (that's lib/db.js), and
// runMigrations leaves foreign_keys ON — so an inserted event needs a real child to reference.
const seedChild = (db) =>
  db.prepare("INSERT OR IGNORE INTO children (id,name,color) VALUES ('c1','Ivy','#4f46e5')").run();

test('migrations include v8 and a fresh DB reaches it', () => {
  assert.ok(migrations.length >= 8);
  const db = freshDb();
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  db.close();
});

test('v8 adds a nullable series_id column to events', () => {
  const db = freshDb();
  const col = db.prepare('PRAGMA table_info(events)').all().find((c) => c.name === 'series_id');
  assert.ok(col, 'series_id column exists');
  assert.equal(col.notnull, 0, 'series_id is nullable');
  db.close();
});

test('v8 leaves existing events with a NULL series_id and can be re-migrated idempotently', () => {
  // Simulate an older DB (stop before v8), insert an event, then finish migrating.
  const db = new Database(':memory:');
  runMigrations(db, migrations.slice(0, 7)); // up to v7
  seedChild(db);
  db.prepare(
    "INSERT INTO events (id,title,type,child_id,pd,date,time) VALUES ('e1','X','school','c1','dropoff','2026-06-01','08:00')"
  ).run();
  runMigrations(db); // apply v8
  assert.equal(db.prepare("SELECT series_id FROM events WHERE id='e1'").get().series_id, null);
  db.close();
});

test('v8 round-trips a series_id and leaves no foreign-key violations', () => {
  const db = freshDb();
  seedChild(db);
  db.prepare(
    "INSERT INTO events (id,title,type,child_id,pd,date,time,series_id) VALUES ('e2','Y','school','c1','dropoff','2026-06-02','09:00','s_abc')"
  ).run();
  assert.equal(db.prepare("SELECT series_id FROM events WHERE id='e2'").get().series_id, 's_abc');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});

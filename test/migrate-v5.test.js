import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, migrations } from '../lib/migrate.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

test('migrations array includes v5 (5+ entries)', () => {
  assert.ok(migrations.length >= 5);
});

test('a fresh DB migrates to at least user_version 5', () => {
  const db = freshDb();
  assert.ok(db.pragma('user_version', { simple: true }) >= 5);
  db.close();
});

test('v5 creates schedules, schedule_overrides, schedule_audit', () => {
  const db = freshDb();
  for (const t of ['schedules', 'schedule_overrides', 'schedule_audit']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    assert.ok(cols.length > 0, `${t} should exist`);
  }
  const schedCols = db
    .prepare('PRAGMA table_info(schedules)')
    .all()
    .map((c) => c.name);
  assert.deepEqual(schedCols, [
    'id',
    'label',
    'preset_key',
    'cycle_len',
    'assignment',
    'anchor_date',
    'starts_on',
    'ends_on',
    'created_at',
    'updated_at',
  ]);
  db.close();
});

test('v5 enforces the cycle_len bound and override FK + date shape', () => {
  const db = freshDb();
  // cycle_len out of range rejected
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO schedules (id,cycle_len,assignment,anchor_date) VALUES ('s1',0,'[]','2026-01-05')"
      )
      .run()
  );
  // override pointing at a missing caregiver rejected (FK on)
  db.pragma('foreign_keys = ON');
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO schedule_overrides (id,caregiver_id,date_from,date_to) VALUES ('o1','nope','2026-01-01','2026-01-02')"
      )
      .run()
  );
  // a valid schedule row inserts cleanly
  db.prepare(
    "INSERT INTO schedules (id,preset_key,cycle_len,assignment,anchor_date) VALUES ('s2','week_on_off',14,'[\"g1\"]','2026-01-05')"
  ).run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, 1);
  db.close();
});

test('v5 leaves no foreign-key violations on a fresh DB', () => {
  const db = freshDb();
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});

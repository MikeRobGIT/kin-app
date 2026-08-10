import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, migrations } from '../lib/migrate.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

test('migrations include v10 and a fresh DB reaches it', () => {
  assert.ok(migrations.length >= 10);
  const db = freshDb();
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  db.close();
});

test('v10 adds a nullable pickup_caregiver_id column to events', () => {
  const db = freshDb();
  const col = db
    .prepare('PRAGMA table_info(events)')
    .all()
    .find((c) => c.name === 'pickup_caregiver_id');
  assert.ok(col, 'pickup_caregiver_id column exists');
  assert.equal(col.notnull, 0); // nullable
  assert.equal(col.dflt_value, null); // defaults to NULL
  db.close();
});

test('v10 pickup_caregiver_id enforces the caregivers FK', () => {
  const db = freshDb(); // runMigrations leaves foreign_keys ON
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Ivy','#000000',0)").run();
  db.prepare("INSERT INTO caregivers (id,name,color,sort) VALUES ('g1','Dad','#000000',0)").run();
  const ins = db.prepare(
    'INSERT INTO events (id,title,type,child_id,caregiver_id,pickup_caregiver_id,pd,date,time) ' +
      "VALUES ('e1','School','school','c1','g1',?, 'both','2026-06-13','08:00')"
  );
  assert.throws(() => ins.run('nope'), /FOREIGN KEY/); // unknown pickup parent rejected
  ins.run('g1'); // a real caregiver id is accepted
  assert.equal(
    db.prepare('SELECT pickup_caregiver_id FROM events WHERE id=?').get('e1').pickup_caregiver_id,
    'g1'
  );
  db.close();
});

test('v10 leaves no foreign-key violations on a fresh DB', () => {
  const db = freshDb();
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});

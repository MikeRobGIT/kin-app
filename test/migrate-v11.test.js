import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, migrations } from '../lib/migrate.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

test('migrations include v11 and a fresh DB reaches it', () => {
  assert.ok(migrations.length >= 11);
  const db = freshDb();
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  db.close();
});

test('v11 adds a NOT NULL DEFAULT 0 archived column to children and caregivers', () => {
  const db = freshDb();
  for (const t of ['children', 'caregivers']) {
    const col = db.prepare(`PRAGMA table_info(${t})`).all().find((c) => c.name === 'archived');
    assert.ok(col, `${t}.archived exists`);
    assert.equal(col.notnull, 1);
    assert.equal(col.dflt_value, '0');
  }
  db.close();
});

test('v11 backfills archived=0 on rows that predate the column', () => {
  // Migrate only up to v10 (no archived column yet), insert rows, THEN apply v11 — so the ALTER
  // ADD COLUMN ... DEFAULT 0 backfill on pre-existing rows is actually exercised (a fresh DB
  // would insert after v11 and only test the column default).
  const db = new Database(':memory:');
  runMigrations(db, migrations.slice(0, 10));
  assert.equal(db.pragma('user_version', { simple: true }), 10);
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Ivy','#000000',0)").run();
  db.prepare("INSERT INTO caregivers (id,name,color,sort) VALUES ('g1','Dad','#000000',0)").run();
  runMigrations(db); // apply v11
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  assert.equal(db.prepare('SELECT archived FROM children WHERE id=?').get('c1').archived, 0);
  assert.equal(db.prepare('SELECT archived FROM caregivers WHERE id=?').get('g1').archived, 0);
  db.close();
});

test('v11 leaves no foreign-key violations on a fresh DB', () => {
  const db = freshDb();
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});

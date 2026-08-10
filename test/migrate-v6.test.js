import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, migrations } from '../lib/migrate.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

test('migrations array includes v6 and a fresh DB reaches it', () => {
  assert.ok(migrations.length >= 6);
  const db = freshDb();
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  db.close();
});

test('v6 creates month_seals with the expected columns', () => {
  const db = freshDb();
  const names = db.prepare('PRAGMA table_info(month_seals)').all().map((c) => c.name).sort();
  assert.deepEqual(names, ['algo', 'event_count', 'hmac', 'id', 'month', 'sealed_at', 'sha256'].sort());
  db.close();
});

test('v6 month CHECK rejects a bad month and accepts YYYY-MM', () => {
  const db = freshDb();
  assert.throws(() =>
    db.prepare("INSERT INTO month_seals (month,sha256,hmac,event_count) VALUES ('2026-6','a','b',0)").run()
  );
  db.prepare("INSERT INTO month_seals (month,sha256,hmac,event_count) VALUES ('2026-06','a','b',3)").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM month_seals').get().n, 1);
  db.close();
});

test('v6 allows re-sealing a month (no UNIQUE — history kept)', () => {
  const db = freshDb();
  const ins = db.prepare("INSERT INTO month_seals (month,sha256,hmac,event_count) VALUES (?,?,?,?)");
  ins.run('2026-06', 'sha1', 'h1', 2);
  ins.run('2026-06', 'sha2', 'h2', 3); // re-seal same month
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM month_seals WHERE month='2026-06'").get().n, 2);
  db.close();
});

test('v6 leaves no foreign-key violations on a fresh DB', () => {
  const db = freshDb();
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});

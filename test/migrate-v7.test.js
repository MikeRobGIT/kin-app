import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, migrations } from '../lib/migrate.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

test('migrations include v7 and a fresh DB reaches it', () => {
  assert.ok(migrations.length >= 7);
  const db = freshDb();
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  db.close();
});

test('v7 creates share_tokens with the expected columns', () => {
  const db = freshDb();
  const names = db.prepare('PRAGMA table_info(share_tokens)').all().map((c) => c.name).sort();
  assert.deepEqual(
    names,
    ['created_at', 'date_from', 'date_to', 'expires_at', 'id', 'label', 'revoked', 'token_hash'].sort()
  );
  db.close();
});

test('v7 enforces UNIQUE token_hash and the date-shape CHECK', () => {
  const db = freshDb();
  const ins = db.prepare(
    "INSERT INTO share_tokens (token_hash,date_from,date_to,expires_at) VALUES (?, '2026-06-01','2026-06-30', datetime('now','+30 days'))"
  );
  ins.run('hash1');
  assert.throws(() => ins.run('hash1')); // duplicate token_hash rejected
  // malformed date_from rejected by CHECK
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO share_tokens (token_hash,date_from,date_to,expires_at) VALUES ('h2','2026-6-1','2026-06-30','x')"
      )
      .run()
  );
  db.close();
});

test('v7 leaves no foreign-key violations on a fresh DB', () => {
  const db = freshDb();
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});

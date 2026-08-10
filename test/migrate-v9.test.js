import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, migrations } from '../lib/migrate.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

test('migrations include v9 and a fresh DB reaches it', () => {
  assert.ok(migrations.length >= 9);
  const db = freshDb();
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  db.close();
});

test('v9 creates mcp_tokens with the expected columns', () => {
  const db = freshDb();
  const names = db.prepare('PRAGMA table_info(mcp_tokens)').all().map((c) => c.name).sort();
  assert.deepEqual(
    names,
    ['created_at', 'id', 'label', 'last_used_at', 'revoked', 'token_hash'].sort()
  );
  db.close();
});

test('v9 enforces UNIQUE token_hash and the revoked CHECK', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO mcp_tokens (token_hash) VALUES (?)');
  ins.run('hash1');
  assert.throws(() => ins.run('hash1')); // duplicate token_hash rejected
  // revoked outside {0,1} rejected by CHECK
  assert.throws(() =>
    db.prepare("INSERT INTO mcp_tokens (token_hash, revoked) VALUES ('h2', 2)").run()
  );
  db.close();
});

test('v9 defaults: unrevoked, created_at stamped, last_used_at NULL', () => {
  const db = freshDb();
  db.prepare('INSERT INTO mcp_tokens (token_hash, label) VALUES (?, ?)').run('h3', 'laptop');
  const row = db.prepare('SELECT * FROM mcp_tokens WHERE token_hash = ?').get('h3');
  assert.equal(row.revoked, 0);
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(row.last_used_at, null);
  db.close();
});

test('v9 leaves no foreign-key violations on a fresh DB', () => {
  const db = freshDb();
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});

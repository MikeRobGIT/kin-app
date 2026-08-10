import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { snapshotBeforeMigrations } from '../lib/backup.js';
import { migrations } from '../lib/migrate.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bk-'));

test('snapshots an existing pre-migration DB to a restorable file', () => {
  const dir = tmp();
  const db = new Database(path.join(dir, 'tracker.db'));
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare("INSERT INTO events (id,title) VALUES ('e1','School')").run();
  const snap = snapshotBeforeMigrations(db, dir, migrations.length);
  assert.ok(snap, 'should return a snapshot path');
  assert.equal(path.basename(snap), 'pre-migration-v0.db');
  assert.ok(fs.existsSync(snap), 'snapshot file should exist');
  const restored = new Database(snap, { readonly: true });
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  assert.equal(restored.prepare("SELECT title FROM events WHERE id='e1'").get().title, 'School');
});

test('is idempotent per version — reuses the existing snapshot, never throws on re-run', () => {
  const dir = tmp();
  const db = new Database(path.join(dir, 'tracker.db'));
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare("INSERT INTO events (id,title) VALUES ('e1','School')").run();
  const first = snapshotBeforeMigrations(db, dir, migrations.length);
  const second = snapshotBeforeMigrations(db, dir, migrations.length); // must not throw
  assert.equal(first, second);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('pre-migration')).length, 1);
});

test('skips snapshot on a fresh DB (no events table yet)', () => {
  const dir = tmp();
  const db = new Database(path.join(dir, 'tracker.db'));
  assert.equal(snapshotBeforeMigrations(db, dir, migrations.length), null);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('pre-migration')).length, 0);
});

test('skips snapshot when already at the latest version', () => {
  const dir = tmp();
  const db = new Database(path.join(dir, 'tracker.db'));
  db.exec('CREATE TABLE events (id TEXT)');
  db.pragma(`user_version = ${migrations.length}`);
  assert.equal(snapshotBeforeMigrations(db, dir, migrations.length), null);
});

test('removes a partial snapshot when VACUUM INTO fails, so a retry recreates it', () => {
  const dir = tmp();
  const version = 3;
  const snap = path.join(dir, `pre-migration-v${version}.db`);
  // Stub a DB whose VACUUM INTO leaves a partial file then fails (SQLITE_BUSY under a swap lock).
  const db = {
    pragma: (q) => (String(q).startsWith('user_version') ? version : undefined),
    prepare: () => ({ get: () => ({ 1: 1 }) }), // hasEvents → true
    exec: () => {
      fs.writeFileSync(snap, 'PARTIAL');
      const e = new Error('database is locked');
      e.code = 'SQLITE_BUSY';
      throw e;
    },
  };
  assert.throws(() => snapshotBeforeMigrations(db, dir, migrations.length), /database is locked/);
  assert.equal(fs.existsSync(snap), false, 'partial snapshot must be removed so the retry recreates it');
});

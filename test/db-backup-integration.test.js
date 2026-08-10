import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-dbbk-'));
  // Hand-build a legacy (user_version 0) DB with an event row, like the live DB.
  const legacy = new Database(path.join(dir, 'tracker.db'));
  legacy.exec(`
    CREATE TABLE children (id TEXT PRIMARY KEY, name TEXT, color TEXT, sort INTEGER);
    CREATE TABLE caregivers (id TEXT PRIMARY KEY, name TEXT, color TEXT, sort INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT, type TEXT, child_id TEXT,
      pd TEXT, date TEXT, time TEXT, who TEXT, notes TEXT, created_at TEXT);
  `);
  legacy.prepare("INSERT INTO children VALUES ('c1','Ivy','#000',0)").run();
  legacy.prepare(
    "INSERT INTO events (id,title,type,child_id,pd,date,time,who,notes,created_at) " +
    "VALUES ('e1','School','school','c1','dropoff','2026-01-01','08:00','','','2026-01-01 12:00:00')"
  ).run();
  legacy.close();
  process.env.DATA_DIR = dir;
});

test('lib/db.js writes a pre-migration snapshot when booting a legacy DB', async () => {
  await import('../lib/db.js'); // runs snapshot + migrations on import
  const snaps = fs.readdirSync(dir).filter((f) => f === 'pre-migration-v0.db');
  assert.equal(snaps.length, 1, 'exactly one pre-migration snapshot');
  const restored = new Database(path.join(dir, snaps[0]), { readonly: true });
  assert.equal(restored.prepare("SELECT title FROM events WHERE id='e1'").get().title, 'School');
});

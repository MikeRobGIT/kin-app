import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { migrations } from '../lib/migrate.js';

let dir, db;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-build-'));
  process.env.DATA_DIR = dir;
  process.env.NEXT_PHASE = 'phase-production-build'; // simulate `next build`
  ({ default: db } = await import('../lib/db.js'));
});

test('during next build, db.js writes NO file to the data volume', () => {
  // Each page-data worker must use a private in-memory DB — otherwise parallel
  // workers contend on one file's write lock and blow past busy_timeout (SQLITE_BUSY).
  assert.equal(fs.existsSync(path.join(dir, 'tracker.db')), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the in-memory build DB still has a valid migrated schema (prepare validates)', () => {
  // db.prepare() compiles against the schema, so the schema must exist at build time.
  assert.doesNotThrow(() => db.prepare('SELECT id, updated_at FROM events LIMIT 1'));
  assert.doesNotThrow(() => db.prepare('SELECT id FROM event_audit LIMIT 1'));
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
});

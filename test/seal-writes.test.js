import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let insertSeal, listSeals, getLatestSeal;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seal-'));
  await import('../lib/db.js'); // runs migrations (incl. v6) on the fresh DB
  ({ insertSeal, listSeals, getLatestSeal } = await import('../lib/seal-writes.js'));
});

const seal = (o) => ({ month: '2026-06', sha256: 'a', hmac: 'b', event_count: 0, ...o });

test('insertSeal returns the persisted row', () => {
  const row = insertSeal(seal({ sha256: 's1', event_count: 3 }));
  assert.equal(row.month, '2026-06');
  assert.equal(row.sha256, 's1');
  assert.equal(row.event_count, 3);
  assert.ok(row.id);
  assert.ok(row.sealed_at);
  assert.equal(row.algo, 'sha256+hmac-sha256'); // column DEFAULT applied
});

test('re-sealing keeps history and getLatestSeal returns the newest', () => {
  insertSeal(seal({ month: '2026-07', sha256: 'first' }));
  const second = insertSeal(seal({ month: '2026-07', sha256: 'second' }));
  const latest = getLatestSeal('2026-07');
  assert.equal(latest.id, second.id);
  assert.equal(latest.sha256, 'second');
  // both rows are retained
  const all = listSeals().filter((s) => s.month === '2026-07');
  assert.equal(all.length, 2);
});

test('getLatestSeal returns undefined for an unsealed month', () => {
  assert.equal(getLatestSeal('1999-01'), undefined);
});

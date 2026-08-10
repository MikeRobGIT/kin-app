import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let db, createShareToken, resolveShareToken, listShareTokens, revokeShareToken, hashToken;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-share-'));
  ({ default: db } = await import('../lib/db.js')); // runs migrations incl. v7
  ({ createShareToken, resolveShareToken, listShareTokens, revokeShareToken } = await import(
    '../lib/share-writes.js'
  ));
  ({ hashToken } = await import('../lib/share.js'));
});

const SECRET = 'a-test-secret';
const mk = (o) => createShareToken({ label: '', date_from: '2026-06-01', date_to: '2026-06-30', days: 30, ...o }, SECRET);

test('create returns the raw token once and stores only its HMAC', () => {
  const { token, row } = mk({ label: 'Smith Law' });
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(row.token_hash, hashToken(token, SECRET));
  assert.notEqual(row.token_hash, token); // raw token never persisted
  assert.equal(row.label, 'Smith Law');
  assert.equal(row.revoked, 0);
  assert.ok(row.expires_at > row.created_at); // ~30 days out
});

test('resolve returns the row for a valid token, undefined for unknown or wrong-key', () => {
  const { token } = mk();
  assert.ok(resolveShareToken(token, SECRET));
  assert.equal(resolveShareToken('deadbeef'.repeat(8), SECRET), undefined);
  assert.equal(resolveShareToken(token, 'wrong-secret'), undefined);
});

test('resolve rejects revoked and expired tokens', () => {
  const { token, row } = mk();
  revokeShareToken(row.id);
  assert.equal(resolveShareToken(token, SECRET), undefined);

  // an already-expired row (past expires_at) also fails to resolve
  const expired = 'b'.repeat(64);
  db.prepare(
    "INSERT INTO share_tokens (token_hash,date_from,date_to,expires_at) VALUES (?, '2026-06-01','2026-06-30', datetime('now','-1 day'))"
  ).run(hashToken(expired, SECRET));
  assert.equal(resolveShareToken(expired, SECRET), undefined);
});

test('list never exposes a usable token and flags active vs not', () => {
  const rows = listShareTokens();
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.equal(r.token, undefined);
    assert.equal(r.token_hash, undefined); // not even the hash is sent to the UI
    assert.ok(r.active === 0 || r.active === 1);
  }
});

test('revoking a missing id changes nothing', () => {
  assert.equal(revokeShareToken(999999), 0);
});

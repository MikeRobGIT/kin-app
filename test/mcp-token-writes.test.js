import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let db, createMcpToken, resolveMcpToken, listMcpTokens, revokeMcpToken, touchMcpToken, hasActiveMcpTokens, hashToken;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mcptok-'));
  ({ default: db } = await import('../lib/db.js')); // runs migrations incl. v9
  ({ createMcpToken, resolveMcpToken, listMcpTokens, revokeMcpToken, touchMcpToken, hasActiveMcpTokens } =
    await import('../lib/mcp-token-writes.js'));
  ({ hashToken } = await import('../lib/share.js'));
});

const SECRET = 'a-test-secret';
const mk = (o) => createMcpToken({ label: '', ...o }, SECRET);

test('hasActiveMcpTokens is false on an empty table', () => {
  assert.equal(hasActiveMcpTokens(), false);
});

test('create returns the raw token once and stores only its HMAC', () => {
  const { token, row } = mk({ label: 'claude code laptop' });
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(row.token_hash, hashToken(token, SECRET));
  assert.notEqual(row.token_hash, token); // raw token never persisted
  assert.equal(row.label, 'claude code laptop');
  assert.equal(row.revoked, 0);
  assert.equal(row.last_used_at, null);
});

test('resolve returns the row for a valid token, undefined for unknown or wrong-key', () => {
  const { token } = mk();
  assert.ok(resolveMcpToken(token, SECRET));
  assert.equal(resolveMcpToken('deadbeef'.repeat(8), SECRET), undefined);
  assert.equal(resolveMcpToken(token, 'wrong-secret'), undefined);
});

test('resolve rejects a revoked token', () => {
  const { token, row } = mk();
  revokeMcpToken(row.id);
  assert.equal(resolveMcpToken(token, SECRET), undefined);
});

test('touch stamps last_used_at', () => {
  const { token, row } = mk();
  assert.equal(row.last_used_at, null);
  touchMcpToken(row.id);
  const after = resolveMcpToken(token, SECRET);
  assert.match(after.last_used_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('list never exposes a usable token and flags active vs not', () => {
  const rows = listMcpTokens();
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.equal(r.token, undefined);
    assert.equal(r.token_hash, undefined); // not even the hash is sent to the UI
    assert.ok(r.active === 0 || r.active === 1);
  }
  // list includes last_used_at for the owner UI
  assert.ok(Object.prototype.hasOwnProperty.call(rows[0], 'last_used_at'));
});

test('revoking a missing id changes nothing', () => {
  assert.equal(revokeMcpToken(999999), 0);
});

test('hasActiveMcpTokens goes true with a live token and false again when all are revoked', () => {
  // revoke everything minted so far, then verify the flag flips with one fresh mint
  db.prepare('UPDATE mcp_tokens SET revoked = 1').run();
  assert.equal(hasActiveMcpTokens(), false);
  const { row } = mk({ label: 'flip' });
  assert.equal(hasActiveMcpTokens(), true);
  revokeMcpToken(row.id);
  assert.equal(hasActiveMcpTokens(), false);
});

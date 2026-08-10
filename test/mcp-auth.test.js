import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const GOOD_ENV = 'x'.repeat(40); // >= 24 chars
const SECRET = 'test-auth-secret-long-enough';

let db, auth, tokens;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mcpauth-'));
  process.env.AUTH_SECRET = SECRET;
  delete process.env.KIN_MCP_TOKEN;
  ({ default: db } = await import('../lib/db.js')); // runs migrations incl. v9
  auth = await import('../lib/mcp-auth.js');
  tokens = await import('../lib/mcp-token-writes.js');
});

const revokeAll = () => db.prepare('UPDATE mcp_tokens SET revoked = 1').run();

// --- env-token fallback (original behavior, unchanged) ----------------------

test('unconfigured when env is unset and no DB tokens exist', () => {
  delete process.env.KIN_MCP_TOKEN;
  revokeAll();
  assert.equal(auth.mcpConfigured(), false);
  assert.equal(auth.verifyKinToken('anything'), false);
});

test('an env token shorter than 24 chars does not configure the server', () => {
  process.env.KIN_MCP_TOKEN = 'short';
  revokeAll();
  assert.equal(auth.mcpConfigured(), false);
  delete process.env.KIN_MCP_TOKEN;
});

test('env token matches only the exact value, constant-time', () => {
  process.env.KIN_MCP_TOKEN = GOOD_ENV;
  assert.equal(auth.mcpConfigured(), true);
  assert.equal(auth.verifyKinToken(GOOD_ENV), true);
  assert.equal(auth.verifyKinToken(GOOD_ENV + 'z'), false); // different length
  assert.equal(auth.verifyKinToken('y'.repeat(40)), false); // same length, wrong value
  assert.equal(auth.verifyKinToken(''), false);
  assert.equal(auth.verifyKinToken(undefined), false);
  delete process.env.KIN_MCP_TOKEN;
});

// --- DB tokens ---------------------------------------------------------------

test('a minted DB token configures and verifies without any env token', () => {
  delete process.env.KIN_MCP_TOKEN;
  revokeAll();
  const { token, row } = tokens.createMcpToken({ label: 'db-only' }, SECRET);
  assert.equal(auth.mcpConfigured(), true); // DB token alone configures
  assert.equal(row.last_used_at, null);
  assert.equal(auth.verifyKinToken(token), true);
  // successful DB verify stamps last_used_at
  const after = db.prepare('SELECT last_used_at FROM mcp_tokens WHERE id = ?').get(row.id);
  assert.match(after.last_used_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('a revoked DB token no longer verifies', () => {
  delete process.env.KIN_MCP_TOKEN;
  revokeAll();
  const { token, row } = tokens.createMcpToken({ label: 'to-revoke' }, SECRET);
  assert.equal(auth.verifyKinToken(token), true);
  tokens.revokeMcpToken(row.id);
  assert.equal(auth.verifyKinToken(token), false);
  assert.equal(auth.mcpConfigured(), false); // last active token gone
});

test('env and DB tokens authenticate side by side', () => {
  process.env.KIN_MCP_TOKEN = GOOD_ENV;
  revokeAll();
  const { token } = tokens.createMcpToken({ label: 'both' }, SECRET);
  assert.equal(auth.verifyKinToken(GOOD_ENV), true);
  assert.equal(auth.verifyKinToken(token), true);
  assert.equal(auth.verifyKinToken('nope'), false);
  delete process.env.KIN_MCP_TOKEN;
  revokeAll();
});

// --- AUTH_SECRET failure modes ------------------------------------------------

test('assertMcpAuthReady throws only when DB tokens exist and AUTH_SECRET is missing', () => {
  revokeAll();
  delete process.env.KIN_MCP_TOKEN;

  // env-only / nothing-configured mode: no DB tokens → never throws, secret or not
  delete process.env.AUTH_SECRET;
  assert.doesNotThrow(() => auth.assertMcpAuthReady());
  process.env.AUTH_SECRET = SECRET;

  // active DB tokens + secret present → fine
  const { token } = tokens.createMcpToken({ label: 'secretful' }, SECRET);
  assert.doesNotThrow(() => auth.assertMcpAuthReady());

  // active DB tokens + secret missing → loud failure (mounts map this to 500)
  delete process.env.AUTH_SECRET;
  assert.throws(() => auth.assertMcpAuthReady(), /AUTH_SECRET/);
  // and the DB verify path fails closed rather than crashing
  assert.equal(auth.verifyKinToken(token), false);

  process.env.AUTH_SECRET = SECRET;
  assert.equal(auth.verifyKinToken(token), true); // recovers with the secret back
  revokeAll();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newToken, hashToken } from '../lib/share.js';

test('newToken is a 256-bit hex secret and unique each call', () => {
  const a = newToken();
  const b = newToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('hashToken is deterministic, keyed by the secret, and per-token', () => {
  assert.equal(hashToken('t', 's'), hashToken('t', 's')); // deterministic
  assert.notEqual(hashToken('t', 's'), hashToken('t', 'other')); // keyed by secret
  assert.notEqual(hashToken('t1', 's'), hashToken('t2', 's')); // per token
  assert.match(hashToken('t', 's'), /^[0-9a-f]{64}$/);
});

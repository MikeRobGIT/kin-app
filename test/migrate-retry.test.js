import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithBusyRetry } from '../lib/migrate.js';

const busy = () => {
  const e = new Error('database is locked');
  e.code = 'SQLITE_BUSY';
  return e;
};

test('runWithBusyRetry retries past transient SQLITE_BUSY and returns the result', () => {
  let calls = 0;
  const retried = [];
  const out = runWithBusyRetry(
    () => {
      calls++;
      if (calls < 3) throw busy();
      return 'migrated';
    },
    { attempts: 5, delayMs: 0, onRetry: (i) => retried.push(i) }
  );
  assert.equal(out, 'migrated');
  assert.equal(calls, 3);
  assert.deepEqual(retried, [1, 2]); // two retries before the third call succeeds
});

test('runWithBusyRetry rethrows a non-BUSY error immediately (a real migration bug is not masked)', () => {
  let calls = 0;
  assert.throws(
    () => runWithBusyRetry(() => { calls++; throw new Error('bad migration'); }, { delayMs: 0 }),
    /bad migration/
  );
  assert.equal(calls, 1);
});

test('runWithBusyRetry gives up after `attempts` and rethrows the BUSY error', () => {
  let calls = 0;
  assert.throws(
    () => runWithBusyRetry(() => { calls++; throw busy(); }, { attempts: 3, delayMs: 0 }),
    /database is locked/
  );
  assert.equal(calls, 3);
});

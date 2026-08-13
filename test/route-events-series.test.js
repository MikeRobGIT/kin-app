import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Route-handler tests for DELETE /api/events/series/[id], covering the `?from=YYYY-MM-DD`
// "this and following" scope. See test/helpers/route-loader.mjs for how a route module gets
// imported under node --test at all, and test/route-subscriptions.test.js for the pattern this
// file follows.
//
// DATA_DIR / AUTH_SECRET must exist and the loader hook must be registered before ANY dynamic
// import below: lib/db.js opens the DB at import time, and lib/auth.js's authSecret() throws on
// a missing/short secret.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-route-series-'));
process.env.AUTH_SECRET = '0123456789abcdef0123456789abcdef';
register('./helpers/route-loader.mjs', import.meta.url);

const { createSession, destroySession } = await import('../lib/auth.js');
const { createEventsBulk } = await import('../lib/event-writes.js');
const { default: db } = await import('../lib/db.js');
const series = await import('../app/api/events/series/[id]/route.js'); // PUT, DELETE

const del = (id, qs = '') =>
  series.DELETE(new Request(`http://localhost/api/events/series/${id}${qs}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });

let n = 0;
const seed = (dates) => {
  const sid = `s_route_${n++}`;
  createEventsBulk(
    dates.map((date) => ({
      title: 'Tutoring', type: 'school', child_id: 'c1', caregiver_id: 'g1',
      pd: 'dropoff', date, time: '16:00', who: '', notes: '',
    })),
    sid
  );
  return sid;
};
const left = (sid) =>
  db.prepare('SELECT date FROM events WHERE series_id = ? ORDER BY date').all(sid).map((r) => r.date);

test('DELETE with no session returns 401', async () => {
  await destroySession();
  const res = await del('anything');
  assert.equal(res.status, 401);
});

test('DELETE with no ?from deletes the whole series', async () => {
  await createSession();
  const sid = seed(['2027-01-04', '2027-01-11', '2027-01-18']);
  const res = await del(sid);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 3 });
  assert.deepEqual(left(sid), []);
});

test('DELETE ?from=<mid date> deletes that date onward only', async () => {
  await createSession();
  const sid = seed(['2027-01-04', '2027-01-11', '2027-01-18']);
  const res = await del(sid, '?from=2027-01-11');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 2 });
  assert.deepEqual(left(sid), ['2027-01-04']);
});

test('DELETE ?from with two same-date occurrences takes both', async () => {
  await createSession();
  const sid = seed(['2027-03-01', '2027-03-08', '2027-03-08']);
  const res = await del(sid, '?from=2027-03-08');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 2 });
  assert.deepEqual(left(sid), ['2027-03-01']);
});

test('DELETE ?from=2027-02-30 (invalid) returns 400 and deletes nothing', async () => {
  await createSession();
  const sid = seed(['2027-04-01', '2027-04-08']);
  const res = await del(sid, '?from=2027-02-30');
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
  assert.equal(left(sid).length, 2);
});

test('DELETE ?from= (empty string) returns 400 and deletes nothing', async () => {
  await createSession();
  const sid = seed(['2027-05-01', '2027-05-08']);
  const res = await del(sid, '?from=');
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
  assert.equal(left(sid).length, 2);
});

test('DELETE ?from past the last occurrence is a 200 no-op, not a 404', async () => {
  // The series exists; the bound just matched nothing. 404 here would tell a client with stale
  // counts that the whole series is gone.
  await createSession();
  const sid = seed(['2027-06-01']);
  const res = await del(sid, '?from=2099-01-01');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 0 });
  assert.equal(left(sid).length, 1);
});

test('DELETE with no ?from on an unknown series still 404s', async () => {
  // The unbounded case keeps its 404 — nothing to delete AND no series is genuinely not-found.
  await createSession();
  const res = await del('s_does_not_exist');
  assert.equal(res.status, 404);
});

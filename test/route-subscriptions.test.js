import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// These are the first route-HANDLER tests in the repo (everything else in test/ exercises a lib
// function directly). A recent merge made PUT /api/subscriptions/[id] return 400 for EVERY
// request — the route's merged patch object omitted `type`, which the validator required — and
// the full green unit suite never noticed, because nothing called the route itself. See
// test/helpers/route-loader.mjs for how a route module gets imported under node --test at all.
//
// DATA_DIR / AUTH_SECRET must exist and the loader hook must be registered before ANY dynamic
// import below: lib/db.js opens the DB at import time, and lib/auth.js's authSecret() throws on
// a missing/short secret.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-route-subs-'));
process.env.AUTH_SECRET = '0123456789abcdef0123456789abcdef';
register('./helpers/route-loader.mjs', import.meta.url);

const { createSession, destroySession } = await import('../lib/auth.js');
const { createEventsBulk } = await import('../lib/event-writes.js');
const { default: db } = await import('../lib/db.js');
const list = await import('../app/api/subscriptions/route.js'); // GET, POST
const item = await import('../app/api/subscriptions/[id]/route.js'); // PUT, DELETE

const req = (method, body) =>
  new Request('http://localhost/api/subscriptions', {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });

const feed = (over = {}) => ({
  label: 'Swim',
  url: 'https://example.test/cal.ics',
  type: 'sport',
  ...over,
});

// Create through the real POST route (not lib/subscription-writes directly) so every test in this
// file exercises the same seam the regression broke.
async function createViaRoute(over = {}) {
  const res = await list.POST(req('POST', feed(over)));
  assert.equal(res.status, 201, 'setup: POST should have created the fixture subscription');
  return res.json();
}

test('every method 401s with no session', async () => {
  await destroySession();
  assert.equal((await list.GET()).status, 401);
  assert.equal((await list.POST(req('POST', feed()))).status, 401);
  assert.equal(
    (await item.PUT(req('PUT', {}), { params: Promise.resolve({ id: 'sub1' }) })).status,
    401
  );
  assert.equal(
    (await item.DELETE(req('DELETE'), { params: Promise.resolve({ id: 'sub1' }) })).status,
    401
  );
});

test('POST creates; the from-title sentinel is accepted and stores pd', async () => {
  await createSession();
  // '' is the "from title" sentinel (lib/constants.js takesLeg): the feed declares no activity
  // and every event is typed from its own title. It still takes a leg, unlike a caregiving type.
  const row = await createViaRoute({ type: '', pd: 'pickup' });
  assert.equal(row.type, '');
  assert.equal(row.pd, 'pickup');
});

test('POST rejects an invalid type', async () => {
  await createSession();
  const res = await list.POST(req('POST', feed({ type: 'not-a-type' })));
  assert.equal(res.status, 400);
});

test('POST rejects a non-feed URL', async () => {
  await createSession();
  const res = await list.POST(req('POST', feed({ url: 'not a url' })));
  assert.equal(res.status, 400);
});

// THE REGRESSION, named as such: the PUT route once built its merged patch object without a
// `type` key when the request body only carried `child_map` (the shape the child-routing UI
// actually sends after a sync). validateSubscriptionPatch's `TYPE_KEYS.includes(undefined)` then
// failed on every such call, so this exact request 400'd for two commits before anyone noticed —
// nothing below the route layer could have caught it, because the merge bug was IN the route.
test('regression: a {child_map}-only PUT returns 200 and leaves label/type/pd untouched', async () => {
  await createSession();
  const s = await createViaRoute({ label: 'Swim', type: 'sport', pd: 'dropoff' });
  const res = await item.PUT(
    req('PUT', { child_map: { minnows: { c: 'c1', t: 'Minnows', s: 'Minnows' } } }),
    { params: Promise.resolve({ id: s.id }) }
  );
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.label, 'Swim');
  assert.equal(row.type, 'sport');
  assert.equal(row.pd, 'dropoff');
  assert.deepEqual(JSON.parse(row.child_map).minnows, { c: 'c1', t: 'Minnows', s: 'Minnows' });
});

test('PUT with {label} only changes the label; the subscription id is unchanged', async () => {
  // The id staying put is the entire point: a new id would orphan every imported event's
  // subscription_id and re-import the whole feed as duplicates on the next sync.
  await createSession();
  const s = await createViaRoute({ label: 'Old name' });
  const res = await item.PUT(req('PUT', { label: 'New name' }), {
    params: Promise.resolve({ id: s.id }),
  });
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.id, s.id);
  assert.equal(row.label, 'New name');
});

test("PUT switching to a caregiving type nulls pd; switching back to '' restores a leg", async () => {
  await createSession();
  const s = await createViaRoute({ type: 'sport', pd: 'both' });

  const toBedtime = await item.PUT(req('PUT', { type: 'bedtime' }), {
    params: Promise.resolve({ id: s.id }),
  });
  assert.equal(toBedtime.status, 200);
  assert.equal((await toBedtime.json()).pd, null);

  const back = await item.PUT(req('PUT', { type: '' }), { params: Promise.resolve({ id: s.id }) });
  assert.equal(back.status, 200);
  const backRow = await back.json();
  assert.equal(backRow.type, '');
  assert.equal(backRow.pd, 'dropoff'); // pd re-defaults; the stale 'both' does not resurrect
});

test('PUT with an invalid type returns 400', async () => {
  await createSession();
  const s = await createViaRoute();
  const res = await item.PUT(req('PUT', { type: 'not-a-type' }), {
    params: Promise.resolve({ id: s.id }),
  });
  assert.equal(res.status, 400);
});

test('PUT on an unknown id returns 404', async () => {
  await createSession();
  const res = await item.PUT(req('PUT', { label: 'x' }), {
    params: Promise.resolve({ id: 'does-not-exist' }),
  });
  assert.equal(res.status, 404);
});

test('DELETE on an unknown id returns 404', async () => {
  await createSession();
  const res = await item.DELETE(req('DELETE'), {
    params: Promise.resolve({ id: 'does-not-exist' }),
  });
  assert.equal(res.status, 404);
});

test('DELETE clears subscription_id on that feed\'s imported events but does not delete them', async () => {
  await createSession();
  const s = await createViaRoute();
  createEventsBulk([
    {
      title: 'Minnows',
      type: 'sport',
      child_id: 'c1',
      pd: 'dropoff',
      date: '2026-08-20',
      time: '10:00',
      subscription_id: s.id,
      ical_uid: 'u-del@rec1',
      ical_key: null,
    },
  ]);

  const res = await item.DELETE(req('DELETE'), { params: Promise.resolve({ id: s.id }) });
  assert.equal(res.status, 200);

  const row = db.prepare("SELECT subscription_id FROM events WHERE ical_uid = 'u-del@rec1'").get();
  assert.ok(row, 'the imported event survives its subscription');
  assert.equal(row.subscription_id, null);
});

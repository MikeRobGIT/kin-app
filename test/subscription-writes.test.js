import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The dedup helpers decide whether an occurrence is silently DROPPED or DUPLICATED, and both
// failures are invisible on a calendar you only glance at. They live in subscription-writes rather
// than the sync route precisely so they can be exercised here without HTTP.
let db, sw, createEventsBulk;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sub-'));
  ({ default: db } = await import('../lib/db.js'));
  sw = await import('../lib/subscription-writes.js');
  ({ createEventsBulk } = await import('../lib/event-writes.js'));
});

const feed = (over = {}) => ({
  label: 'Swim',
  url: 'https://example.test/cal.ics',
  type: 'sport',
  ...over,
});

// One imported occurrence, as the sync route would write it.
function importOne(sub_id, { uid, date, key = null, child_id = 'c1' }) {
  return createEventsBulk([
    {
      title: 'Minnows',
      type: 'sport',
      child_id,
      pd: 'dropoff',
      date,
      time: '10:30',
      subscription_id: sub_id,
      ical_uid: uid,
      ical_key: key,
    },
  ]);
}

test('createSubscription stores a null child_id for a per-event feed', () => {
  const pinned = sw.createSubscription(feed({ child_id: 'c1' }));
  assert.equal(pinned.child_id, 'c1');
  assert.equal(pinned.child_map, '{}');
  // An ABSENT child_id must not throw "Missing named parameter" — it means per-event routing.
  const routed = sw.createSubscription(feed());
  assert.equal(routed.child_id, null);
});

test('updateSubscription patches routing; setChildMap leaves child_id alone', () => {
  const s = sw.createSubscription(feed({ child_id: 'c1' }));
  // updateSubscription takes a full merged row now (label/type/pd required); merge over the stored
  // row the way the PUT route does, since this test only means to exercise the routing fields.
  const patched = sw.updateSubscription(s.id, {
    label: s.label,
    type: s.type,
    pd: s.pd,
    child_id: null,
    child_map: { 'minnows 3yr 5yr': { c: 'c2', t: 'Minnows', s: 'Minnows (3yr-5yr)' } },
  });
  assert.equal(patched.child_id, null);
  assert.deepEqual(JSON.parse(patched.child_map)['minnows 3yr 5yr'], {
    c: 'c2', t: 'Minnows', s: 'Minnows (3yr-5yr)',
  });

  sw.setChildMap(s.id, { other: '' });
  const after = sw.getSubscription(s.id);
  assert.equal(after.child_id, null); // sync-time write must not touch the pinned child
  assert.deepEqual(JSON.parse(after.child_map), { other: '' });
});

test('two kids sharing one uid+date both import, then neither re-imports', () => {
  // The case ical_key exists for: a feed whose UID identifies the CLASS, not the registration.
  const s = sw.createSubscription(feed());
  const uid = 'class-1@rec1', date = '2026-08-15';
  const opts = (key) => ({ perEvent: true, key });

  assert.equal(sw.isImported(s.id, uid, date, opts('minnows')), false);
  importOne(s.id, { uid, date, key: 'minnows', child_id: 'c1' });

  // Kid B has a DIFFERENT routing key, so kid A's row must not mask it.
  assert.equal(sw.isImported(s.id, uid, date, opts('beginner swimming')), false);
  importOne(s.id, { uid, date, key: 'beginner swimming', child_id: 'c2' });

  // Re-sync: both now known.
  assert.equal(sw.isImported(s.id, uid, date, opts('minnows')), true);
  assert.equal(sw.isImported(s.id, uid, date, opts('beginner swimming')), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE subscription_id = ?').get(s.id).n, 2);
});

test('a pinned import blocks a per-event re-import — a mode switch must not duplicate', () => {
  const s = sw.createSubscription(feed({ child_id: 'c1' }));
  const uid = 'u-pin@rec1', date = '2026-08-22';
  importOne(s.id, { uid, date, key: null }); // pinned rows carry ical_key NULL

  // After switching to per-event the occurrence routes to a key that no row has. Matching the legacy
  // NULL row is what stops the whole feed re-importing as duplicates.
  assert.equal(sw.isImported(s.id, uid, date, { perEvent: true, key: 'minnows' }), true);
  assert.equal(sw.isImportedUnkeyed(s.id, uid, date), true);
});

test('a per-event import blocks a pinned re-import — the reverse switch too', () => {
  const s = sw.createSubscription(feed());
  const uid = 'u-routed@rec1', date = '2026-08-29';
  importOne(s.id, { uid, date, key: 'minnows' });
  // Pinned ignores ical_key entirely, so the keyed row still counts as imported.
  assert.equal(sw.isImported(s.id, uid, date, { perEvent: false }), true);
});

test('isImportedUnkeyed does not let one kid mask another on an always-per-event feed', () => {
  // The strict NULL-key lookup: kid A's KEYED row must not make kid B's unrouted occurrence look
  // "already imported", or kid B would be reported as skipped and never surface for assignment.
  const s = sw.createSubscription(feed());
  const uid = 'u-mask@rec1', date = '2026-09-05';
  importOne(s.id, { uid, date, key: 'minnows' });
  assert.equal(sw.isImportedUnkeyed(s.id, uid, date), false);
});

test('dedup is scoped to its own subscription', () => {
  const a = sw.createSubscription(feed());
  const b = sw.createSubscription(feed());
  const uid = 'shared@rec1', date = '2026-09-12';
  importOne(a.id, { uid, date, key: 'minnows' });
  assert.equal(sw.isImported(a.id, uid, date, { perEvent: true, key: 'minnows' }), true);
  assert.equal(sw.isImported(b.id, uid, date, { perEvent: true, key: 'minnows' }), false);
});

test('updateSubscription persists label, type and pd on the SAME row', () => {
  // Editing in place rather than delete + re-add is the entire point: a new subscription id would
  // orphan every imported event's subscription_id tag, so the next sync would match nothing and
  // re-import the whole feed as duplicates.
  const s = sw.createSubscription(feed({ label: 'old', type: 'sport', pd: 'dropoff' }));
  const u = sw.updateSubscription(s.id, {
    label: 'Cobb County swim',
    type: '',
    pd: 'both',
    child_id: null,
    child_map: {},
  });
  assert.equal(u.id, s.id);
  assert.equal(u.label, 'Cobb County swim');
  assert.equal(u.type, '');
  assert.equal(u.pd, 'both');
  assert.equal(u.url, s.url); // url is create-time and must survive the patch untouched
});

test('createSubscription stores a leg for the from-title sentinel', () => {
  // '' takes a leg because every from-title outcome is trip-typed; a caregiving type does not.
  const picked = sw.createSubscription(feed({ type: '', pd: 'pickup' }));
  assert.equal(picked.type, '');
  assert.equal(picked.pd, 'pickup');
  const defaulted = sw.createSubscription(feed({ type: '' }));
  assert.equal(defaulted.pd, 'dropoff');
  const caregiving = sw.createSubscription(feed({ type: 'meal' }));
  assert.equal(caregiving.pd, null);
});

test('deleting a subscription untags its events rather than deleting them', () => {
  const s = sw.createSubscription(feed());
  importOne(s.id, { uid: 'u-del@rec1', date: '2026-09-19', key: 'minnows' });
  sw.deleteSubscription(s.id);
  assert.equal(sw.getSubscription(s.id), undefined);
  const row = db.prepare("SELECT subscription_id, ical_key FROM events WHERE ical_uid = 'u-del@rec1'").get();
  assert.ok(row, 'the imported event survives its subscription');
  assert.equal(row.subscription_id, null);
});

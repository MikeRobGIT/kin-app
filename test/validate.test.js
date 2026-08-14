import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRealDate,
  isRealTime,
  validateEventFields,
  validateEvent,
  validateRecurrence,
  validateMcpTokenInput,
  validateSubscription,
  validateChildMap,
  validateSubscriptionPatch,
  RULE_LIMITS,
  LIMITS,
  REPEAT,
} from '../lib/validate.js';

test('isRealDate rejects impossible / malformed dates', () => {
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-6-1', 'nope', '', null]) {
    assert.equal(isRealDate(bad), false, `${bad} should be invalid`);
  }
  for (const ok of ['2026-06-13', '2024-02-29']) {
    assert.equal(isRealDate(ok), true, `${ok} should be valid`);
  }
});

test('isRealTime bounds hours and minutes', () => {
  for (const bad of ['99:99', '24:00', '12:60', '7:00', '', null]) {
    assert.equal(isRealTime(bad), false, `${bad} should be invalid`);
  }
  for (const ok of ['08:00', '23:59', '00:00']) {
    assert.equal(isRealTime(ok), true, `${ok} should be valid`);
  }
});

test('validateEventFields enforces required, type, pd, dates, caps', () => {
  const base = {
    title: 'School run', type: 'school', pd: 'dropoff',
    date: '2026-06-13', time: '08:00', who: '', notes: '',
  };
  assert.equal(validateEventFields(base), null);
  assert.equal(validateEventFields({ ...base, title: '   ' }), 'Title is required');
  assert.equal(validateEventFields({ ...base, title: 'x'.repeat(LIMITS.title + 1) }), 'Title too long');
  assert.equal(validateEventFields({ ...base, type: 'nope' }), 'Invalid type');
  assert.equal(validateEventFields({ ...base, pd: 'sideways' }), 'Invalid trip kind');
  assert.equal(validateEventFields({ ...base, date: '2026-02-30' }), 'Invalid date');
  assert.equal(validateEventFields({ ...base, time: '99:99' }), 'Invalid time');
  assert.equal(validateEventFields({ ...base, notes: 'x'.repeat(LIMITS.notes + 1) }), 'Notes too long');
  // 'none' — a trip-typed activity that carried no leg this time (a school day spent at home)
  assert.equal(validateEventFields({ ...base, pd: 'none' }), null);
  // non-trip type ignores pd. This stays ONE-DIRECTIONAL on purpose, unlike
  // validateSubscriptionPatch: the add/edit modal POSTs its whole form and always populates pd, so
  // rejecting a stale pd on a caregiving type here would 400 every single Caregiving save.
  assert.equal(validateEventFields({ ...base, type: 'meal', pd: 'whatever' }), null);
});

test('validateRecurrence accepts a valid until-date and count rule', () => {
  const until = { weekdays: ['tue', 'thu'], from: '2026-06-01', interval: 1, endType: 'until', until: '2026-06-30' };
  assert.equal(validateRecurrence(until), null);
  const count = { weekdays: ['mon'], from: '2026-06-01', interval: 2, endType: 'count', count: 10 };
  assert.equal(validateRecurrence(count), null);
});

test('validateRecurrence rejects bad rules', () => {
  const ok = { weekdays: ['tue'], from: '2026-06-01', interval: 1, endType: 'until', until: '2026-06-30' };
  assert.equal(validateRecurrence({ ...ok, weekdays: [] }), 'Pick at least one weekday');
  assert.equal(validateRecurrence({ ...ok, from: '2026-13-01' }), 'Invalid start date');
  assert.equal(validateRecurrence({ ...ok, interval: 0 }), 'Invalid interval');
  assert.equal(validateRecurrence({ ...ok, interval: REPEAT.maxInterval + 1 }), 'Invalid interval');
  assert.equal(validateRecurrence({ ...ok, until: '2026-05-01' }), 'End date is before start date');
  assert.equal(validateRecurrence({ ...ok, until: 'nope' }), 'Invalid end date');
  assert.equal(
    validateRecurrence({ ...ok, endType: 'count', count: REPEAT.maxCount + 1 }),
    'Invalid occurrence count'
  );
  assert.equal(validateRecurrence({ ...ok, endType: 'count', count: 0 }), 'Invalid occurrence count');
});

test('validateMcpTokenInput: label optional, capped, body must be an object', () => {
  assert.equal(validateMcpTokenInput({}), null); // label optional
  assert.equal(validateMcpTokenInput({ label: 'claude code laptop' }), null);
  assert.equal(validateMcpTokenInput({ label: '' }), null);
  assert.equal(validateMcpTokenInput(null), 'Invalid body');
  assert.equal(validateMcpTokenInput('x'), 'Invalid body');
  assert.equal(validateMcpTokenInput({ label: 'x'.repeat(LIMITS.label + 1) }), 'Label too long');
});

test('validateEvent checks child, caregiver, and pickup caregiver existence', () => {
  // Mock db: any id in the known set resolves, anything else is missing.
  const known = ['c1', 'g1', 'g2'];
  const db = { prepare: () => ({ get: (id) => (known.includes(id) ? { id } : undefined) }) };
  const base = {
    title: 'School run', type: 'school', pd: 'both', child_id: 'c1', caregiver_id: 'g1',
    date: '2026-06-13', time: '08:00', who: '', notes: '',
  };
  assert.equal(validateEvent({ ...base, pickup_caregiver_id: 'g2' }, db), null);
  assert.equal(validateEvent({ ...base, pickup_caregiver_id: '' }, db), null); // blank pickup is fine
  assert.equal(
    validateEvent({ ...base, pickup_caregiver_id: 'gX' }, db),
    'Unknown pickup caregiver'
  );
  assert.equal(validateEvent({ ...base, child_id: 'cX' }, db), 'Unknown child');
  assert.equal(validateEvent({ ...base, caregiver_id: 'gX' }, db), 'Unknown caregiver');
});

// ---- iCal subscriptions: optional child + routing rules (v13) ----------------

// Mock db that honours the `archived = 0` filter, so active-gated and existence-only lookups can be
// told apart: c1/c2 are active, c9 exists but is archived.
const subDb = {
  prepare: (sql) => ({
    get: (id) => {
      const pool = sql.includes('archived = 0') ? ['c1', 'c2'] : ['c1', 'c2', 'c9'];
      return pool.includes(id) ? { id } : undefined;
    },
  }),
};
const feed = { url: 'https://example.test/cal.ics', type: 'sport' };

test('validateSubscription accepts an absent child_id — that means per-event routing', () => {
  assert.equal(validateSubscription(feed, subDb), null);
  assert.equal(validateSubscription({ ...feed, child_id: '' }, subDb), null);
  assert.equal(validateSubscription({ ...feed, child_id: null }, subDb), null);
  assert.equal(validateSubscription({ ...feed, child_id: 'c1' }, subDb), null);
  // A child_id that IS supplied must still resolve.
  assert.equal(validateSubscription({ ...feed, child_id: 'cX' }, subDb), 'Unknown child');
  assert.equal(
    validateSubscription({ ...feed, child_id: 'cX' }, subDb, { requireActive: true }),
    'Unknown or archived child'
  );
});

test("validateSubscription accepts '' as the from-title sentinel", () => {
  assert.equal(validateSubscription({ ...feed, type: '' }, subDb), null);
  assert.equal(validateSubscription({ ...feed, type: '', pd: 'pickup' }, subDb), null);
  // '' is the ONLY non-key string that passes.
  assert.equal(validateSubscription({ ...feed, type: 'nope' }, subDb), 'Invalid type');
  assert.equal(validateSubscription({ ...feed, type: undefined }, subDb), 'Invalid type');
  // The sentinel carries a leg, so an invalid one is still caught.
  assert.equal(validateSubscription({ ...feed, type: '', pd: 'sideways' }, subDb), 'Invalid trip kind');
});

test('validateChildMap accepts an activity type on a rule, strictly', () => {
  assert.equal(validateChildMap({ k: { c: 'c1', y: '' } }, subDb), null); // '' = auto
  assert.equal(validateChildMap({ k: { c: 'c1', y: 'camp' } }, subDb), null);
  assert.equal(validateChildMap({ k: { c: 'c1', t: 'Swim', s: 'Minnows', y: 'sport' } }, subDb), null);
  // Strict membership here, unlike `child` which is existence-only: the client picks from a select of
  // live TYPES, and a value outside TYPE_KEYS would fail validateEventFields at import and abort the
  // entire sync with a message naming the wrong cause.
  assert.equal(validateChildMap({ k: { c: 'c1', y: 'nope' } }, subDb), 'Invalid calendar rule');
  assert.equal(validateChildMap({ k: { c: 'c1', y: 5 } }, subDb), 'Invalid calendar rule');
  // ...and an unknown property is still rejected.
  assert.equal(validateChildMap({ k: { c: 'c1', z: 'x' } }, subDb), 'Invalid calendar rule');
});

test('validateChildMap bounds the rule map and checks every assigned child', () => {
  assert.equal(validateChildMap(null, subDb), null);
  assert.equal(validateChildMap({}, subDb), null);
  assert.equal(validateChildMap({ 'minnows 3yr 5yr': '' }, subDb), null); // pending
  assert.equal(validateChildMap({ 'minnows 3yr 5yr': 'c1' }, subDb), null);
  assert.equal(validateChildMap({ k: { c: 'c1', t: 'Minnows', s: 'Minnows (3yr-5yr)' } }, subDb), null);

  assert.equal(validateChildMap([], subDb), 'Invalid calendar rules');
  assert.equal(validateChildMap('nope', subDb), 'Invalid calendar rules');
  assert.equal(validateChildMap({ k: 'cX' }, subDb), 'Unknown child');
  assert.equal(validateChildMap({ k: 1 }, subDb), 'Invalid calendar rule');
  assert.equal(validateChildMap({ '': 'c1' }, subDb), 'Invalid calendar rule');
  assert.equal(validateChildMap({ ['k'.repeat(RULE_LIMITS.key + 1)]: 'c1' }, subDb), 'Invalid calendar rule');
  assert.equal(validateChildMap({ k: { c: 'c1', bogus: 1 } }, subDb), 'Invalid calendar rule');
  assert.equal(validateChildMap({ k: { c: 'c1', t: 'x'.repeat(LIMITS.title + 1) } }, subDb), 'Invalid calendar rule');

  const tooMany = Object.fromEntries(Array.from({ length: RULE_LIMITS.keys + 1 }, (_, i) => [`k${i}`, '']));
  assert.equal(validateChildMap(tooMany, subDb), 'Too many calendar rules');
});

test('validateChildMap is existence-only, so an archived assignment cannot block later saves', () => {
  // The client PUTs the whole map. Active-gating would make one stale entry pointing at a
  // since-archived child (c9) reject every LATER save on that feed, naming the wrong rule. Safe
  // because routeTitle resolves against the ACTIVE roster, so such a rule just returns to review.
  assert.equal(validateChildMap({ stale: 'c9' }, subDb), null);
  assert.equal(validateChildMap({ stale: 'c9', fresh: 'c1' }, subDb), null);
  assert.equal(validateChildMap({ stale: { c: 'c9', t: '', s: 'Old' } }, subDb), null);
});

test('validateSubscriptionPatch guards both the pinned child and the rule map', () => {
  // The patch validator sees a MERGED row (the route merges the body over the stored row before
  // calling), so every field is present. A partial object is a caller bug, and is rejected.
  const base = { child_id: null, child_map: {}, label: 'Swim', type: 'sport', pd: 'dropoff' };
  assert.equal(validateSubscriptionPatch(base, subDb), null);
  assert.equal(validateSubscriptionPatch({ ...base, child_id: 'c2' }, subDb), null);
  assert.equal(validateSubscriptionPatch({ ...base, child_id: 'cX' }, subDb), 'Unknown or archived child');
  // The PINNED child stays active-gated — assigning a feed to a retired kid is a fresh assertion.
  assert.equal(validateSubscriptionPatch({ ...base, child_id: 'c9' }, subDb), 'Unknown or archived child');
  assert.equal(validateSubscriptionPatch({ ...base, child_map: { k: 'cX' } }, subDb), 'Unknown child');
  assert.equal(validateSubscriptionPatch(null, subDb), 'Invalid body');
});

test('validateSubscriptionPatch validates the MERGED row, not just the supplied fields', () => {
  // The PR #27 rule: check the state the row will END UP in. A trip → caregiving switch that left a
  // stale pd behind would have normalize() and lib/report.js disagree about the transport leg.
  const base = { child_id: null, child_map: {}, label: 'Swim', type: 'sport', pd: 'dropoff' };
  assert.equal(validateSubscriptionPatch({ ...base, type: '' }, subDb), null);
  assert.equal(validateSubscriptionPatch({ ...base, type: 'bogus' }, subDb), 'Invalid type');
  assert.equal(validateSubscriptionPatch({ ...base, label: 'x'.repeat(61) }, subDb), 'Label too long');
  assert.equal(validateSubscriptionPatch({ ...base, label: 'x'.repeat(60) }, subDb), null);
  // A caregiving type carries no leg, so the route must have cleared pd before we got here.
  assert.equal(validateSubscriptionPatch({ ...base, type: 'meal', pd: null }, subDb), null);
  // The sentinel DOES carry a leg — every from-title outcome is trip-typed.
  assert.equal(validateSubscriptionPatch({ ...base, type: '', pd: 'sideways' }, subDb), 'Invalid trip kind');
  // The UNCLEARED direction — the one the old check missed entirely.
  assert.equal(
    validateSubscriptionPatch({ ...base, type: 'meal', pd: 'dropoff' }, subDb),
    'This activity has no drop-off or pickup leg'
  );
  // '' and null both mean "no leg" and stay acceptable.
  assert.equal(validateSubscriptionPatch({ ...base, type: 'meal', pd: '' }, subDb), null);
});

test("a subscription cannot be set leg-less — 'none' is an event-level trip kind", () => {
  // pd='none' is valid on an EVENT but must never reach a whole feed: sync stamps the
  // subscription's pd on every row it imports, so a school feed set to 'none' would silently strip
  // the transport leg off a year of real school runs. Unreachable from Settings; this closes the
  // raw-API path on both the create and the patch validator.
  const msg = 'A feed cannot be leg-less — set No trip on the individual event';
  assert.equal(
    validateSubscription({ url: 'https://x/y.ics', type: 'school', pd: 'none', child_id: 'c1' }, subDb),
    msg
  );
  assert.equal(
    validateSubscriptionPatch({ child_id: null, child_map: {}, type: 'school', pd: 'none' }, subDb),
    msg
  );
  // The three real feed-level kinds still pass, so the guard is narrow.
  assert.equal(
    validateSubscription({ url: 'https://x/y.ics', type: 'school', pd: 'both', child_id: 'c1' }, subDb),
    null
  );
});

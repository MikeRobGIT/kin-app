import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMonth, sealMonth, verifySeal } from '../lib/seal.js';
import { resolvePreset } from '../lib/schedule.js';

const ev = (o) => ({
  id: 'e1', date: '2026-06-10', time: '08:00', type: 'school', child_id: 'c1',
  caregiver_id: 'g1', pd: 'dropoff', title: 'Drop', who: '', notes: '', ...o,
});
const schedule = {
  id: 's1', cycle_len: 14, assignment: JSON.stringify(resolvePreset('week_on_off', 'g1', 'g2')),
  anchor_date: '2026-06-01', starts_on: null, ends_on: null, created_at: '2026-01-01 00:00:00',
};
const SECRET = 'test-secret';

test('canonicalMonth is order-independent and only includes the target month', () => {
  const a = [ev({ id: 'e1', date: '2026-06-10' }), ev({ id: 'e2', date: '2026-06-02' })];
  const b = [ev({ id: 'e2', date: '2026-06-02' }), ev({ id: 'e1', date: '2026-06-10' })];
  const out = ev({ id: 'e3', date: '2026-07-01' }); // outside June
  const A = canonicalMonth('2026-06', [...a, out], [schedule]);
  const B = canonicalMonth('2026-06', [...b], [schedule]);
  assert.equal(A.canonical, B.canonical); // input order doesn't matter
  assert.equal(A.eventCount, 2); // the July event is excluded
});

test('sealMonth is deterministic and covers all nights of the month', () => {
  const s1 = sealMonth('2026-06', [ev()], [schedule], [], SECRET);
  const s2 = sealMonth('2026-06', [ev()], [schedule], [], SECRET);
  assert.equal(s1.sha256, s2.sha256);
  assert.equal(s1.hmac, s2.hmac);
  assert.match(s1.sha256, /^[0-9a-f]{64}$/);
  assert.match(s1.hmac, /^[0-9a-f]{64}$/);
  assert.equal(s1.event_count, 1);
  // June has 30 nights — changing an override inside June must change the seal.
  const withOv = sealMonth('2026-06', [ev()], [schedule],
    [{ id: 'o1', caregiver_id: 'g2', date_from: '2026-06-15', date_to: '2026-06-15', created_at: '2026-06-01 00:00:00' }],
    SECRET);
  assert.notEqual(s1.sha256, withOv.sha256);
});

test('verifySeal matches unchanged data and flags a tampered event', () => {
  const events = [ev({ title: 'School drop-off' })];
  const sealed = sealMonth('2026-06', events, [schedule], [], SECRET);
  const seal = { month: '2026-06', sha256: sealed.sha256, hmac: sealed.hmac };

  const ok = verifySeal(seal, events, [schedule], [], SECRET);
  assert.equal(ok.match, true);

  const tampered = [ev({ title: 'Changed after sealing' })];
  const bad = verifySeal(seal, tampered, [schedule], [], SECRET);
  assert.equal(bad.match, false);

  // a deleted event also breaks the seal
  const gone = verifySeal(seal, [], [schedule], [], SECRET);
  assert.equal(gone.match, false);
});

test('the hmac is keyed by the secret (sha256 alone is not enough)', () => {
  const a = sealMonth('2026-06', [ev()], [schedule], [], 'secret-A');
  const b = sealMonth('2026-06', [ev()], [schedule], [], 'secret-B');
  assert.equal(a.sha256, b.sha256); // sha is secret-independent
  assert.notEqual(a.hmac, b.hmac); // hmac diverges with the key
  // verifying with the wrong secret fails even if the data is unchanged
  const seal = { month: '2026-06', sha256: a.sha256, hmac: a.hmac };
  assert.equal(verifySeal(seal, [ev()], [schedule], [], 'secret-B').match, false);
});

test('an event without a pickup parent seals byte-identically (old seals still verify)', () => {
  // A null pickup_caregiver_id must NOT appear in the canonical form — otherwise adding the
  // column would change every already-sealed month's digest and raise a false "tampered" alarm.
  const withNull = canonicalMonth('2026-06', [ev({ pickup_caregiver_id: null })], [schedule]);
  const absent = canonicalMonth('2026-06', [ev()], [schedule]); // field entirely absent
  assert.equal(withNull.canonical, absent.canonical);
  assert.ok(!withNull.canonical.includes('pickup_caregiver_id'));
});

test('a distinct pickup parent is sealed and changes the digest', () => {
  const base = sealMonth('2026-06', [ev({ pd: 'both' })], [schedule], [], SECRET);
  const split = sealMonth(
    '2026-06',
    [ev({ pd: 'both', pickup_caregiver_id: 'g2' })],
    [schedule],
    [],
    SECRET
  );
  assert.notEqual(base.sha256, split.sha256); // sealing the pickup parent changes the record
  const c = canonicalMonth('2026-06', [ev({ pd: 'both', pickup_caregiver_id: 'g2' })], [schedule]);
  assert.ok(c.canonical.includes('pickup_caregiver_id'));
});

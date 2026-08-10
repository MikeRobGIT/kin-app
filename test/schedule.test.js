import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS,
  PRESET_KEYS,
  resolvePreset,
  splitPercent,
  parentOnDate,
  overnightCounts,
  dayIndex,
  detectCycle,
  softColor,
  initials,
  eachDay,
  ymdLocal,
  parseYmd,
} from '../lib/schedule.js';

// Expected A/B split (count of the A parent) per preset, per the taxonomy table.
const EXPECTED_A = {
  week_on_off: 7,
  two_two_three: 7,
  two_two_five_five: 7,
  three_four_four_three: 7,
  alt_two: 2,
  every_other_weekend: 11,
};

test('every preset pattern length equals its cycleLen', () => {
  for (const [key, p] of Object.entries(PRESETS)) {
    assert.equal(p.pattern.length, p.cycleLen, `${key} length`);
  }
});

test('preset splits match the taxonomy (A count over the cycle)', () => {
  for (const [key, p] of Object.entries(PRESETS)) {
    const resolved = resolvePreset(key, 'g1', 'g2');
    const { count } = splitPercent(resolved);
    assert.equal(count.g1 || 0, EXPECTED_A[key], `${key} A count`);
    assert.equal((count.g1 || 0) + (count.g2 || 0), p.cycleLen, `${key} total`);
  }
});

test('every_other_weekend resolves to ~79/21', () => {
  const { pct } = splitPercent(resolvePreset('every_other_weekend', 'g1', 'g2'));
  assert.equal(pct.g1, 79);
  assert.equal(pct.g2, 21);
});

test('PRESET_KEYS includes all presets plus custom', () => {
  assert.ok(PRESET_KEYS.includes('custom'));
  for (const k of Object.keys(PRESETS)) assert.ok(PRESET_KEYS.includes(k));
});

const baseWeekOnOff = {
  id: 's1',
  cycle_len: 14,
  assignment: JSON.stringify(resolvePreset('week_on_off', 'g1', 'g2')),
  anchor_date: '2026-01-05', // a Monday
  starts_on: null,
  ends_on: null,
  created_at: '2026-01-01 00:00:00',
};

test('parentOnDate: anchor day, second week, and periodicity', () => {
  assert.equal(parentOnDate('2026-01-05', [baseWeekOnOff]), 'g1'); // Mon wk1
  assert.equal(parentOnDate('2026-01-12', [baseWeekOnOff]), 'g2'); // Mon wk2
  assert.equal(parentOnDate('2026-01-19', [baseWeekOnOff]), 'g1'); // +14 → same as anchor
});

test('parentOnDate handles dates before the anchor', () => {
  // 2026-01-04 is the Sunday before the anchor → cycle index 13 → 'B' → g2
  assert.equal(parentOnDate('2026-01-04', [baseWeekOnOff]), 'g2');
});

test('parentOnDate returns null when nothing covers the date', () => {
  assert.equal(parentOnDate('2026-01-05', []), null);
});

test('overrides win over the base schedule', () => {
  const overrides = [
    {
      id: 'o1',
      caregiver_id: 'g2',
      date_from: '2026-01-05',
      date_to: '2026-01-05',
      created_at: '2026-01-02 00:00:00',
    },
  ];
  // base says g1 on the anchor; the override flips it to g2
  assert.equal(parentOnDate('2026-01-05', [baseWeekOnOff], overrides), 'g2');
  // a day outside the override falls through to the base
  assert.equal(parentOnDate('2026-01-06', [baseWeekOnOff], overrides), 'g1');
});

test('latest override wins when two cover the same date', () => {
  const overrides = [
    { id: 'o1', caregiver_id: 'g1', date_from: '2026-07-04', date_to: '2026-07-04', created_at: '2026-01-01 00:00:00' },
    { id: 'o2', caregiver_id: 'g2', date_from: '2026-07-04', date_to: '2026-07-04', created_at: '2026-06-01 00:00:00' },
  ];
  assert.equal(parentOnDate('2026-07-04', [], overrides), 'g2');
});

test('a bounded summer segment beats the open-ended base', () => {
  const summer = {
    id: 's2',
    cycle_len: 14,
    assignment: JSON.stringify(resolvePreset('week_on_off', 'g2', 'g1')), // swapped
    anchor_date: '2026-06-01',
    starts_on: '2026-06-01',
    ends_on: '2026-08-31',
    created_at: '2026-05-01 00:00:00',
  };
  // 2026-06-01 is a Monday → summer index 0 → 'g2'; open base would give 'g1' that day
  assert.equal(parentOnDate('2026-06-01', [baseWeekOnOff, summer]), 'g2');
  // outside summer, the open base applies
  assert.equal(parentOnDate('2026-01-05', [baseWeekOnOff, summer]), 'g1');
});

test('overnightCounts: week-on/off splits a 14-night range 7/7', () => {
  // 2026-01-05 (anchor, Mon) .. 2026-01-18 inclusive = 14 nights; wk1 g1, wk2 g2.
  const r = overnightCounts('2026-01-05', '2026-01-18', [baseWeekOnOff]);
  assert.equal(r.total, 14);
  assert.equal(r.counts.g1, 7);
  assert.equal(r.counts.g2, 7);
  assert.equal(r.unassigned, 0);
});

test('overnightCounts: inclusive single-night range', () => {
  const r = overnightCounts('2026-01-05', '2026-01-05', [baseWeekOnOff]);
  assert.equal(r.total, 1);
  assert.equal(r.counts.g1, 1);
});

test('overnightCounts: an override shifts one night to the other parent', () => {
  const overrides = [
    { id: 'o1', caregiver_id: 'g2', date_from: '2026-01-05', date_to: '2026-01-05', created_at: '2026-01-02 00:00:00' },
  ];
  const r = overnightCounts('2026-01-05', '2026-01-18', [baseWeekOnOff], overrides);
  assert.equal(r.total, 14);
  assert.equal(r.counts.g1, 6); // lost the anchor night
  assert.equal(r.counts.g2, 8);
});

test('overnightCounts: nights with no covering schedule count as unassigned', () => {
  const r = overnightCounts('2026-01-01', '2026-01-03', []);
  assert.equal(r.total, 3);
  assert.equal(r.unassigned, 3);
  assert.deepEqual(r.counts, {});
});

test('overnightCounts: reversed or invalid range returns zeros', () => {
  assert.deepEqual(overnightCounts('2026-02-01', '2026-01-01', [baseWeekOnOff]), {
    counts: {}, unassigned: 0, total: 0,
  });
  assert.equal(overnightCounts('', '', [baseWeekOnOff]).total, 0);
});

test('dayIndex folds negative diffs into range', () => {
  assert.equal(dayIndex('2026-01-05', '2026-01-05', 14), 0);
  assert.equal(dayIndex('2026-01-05', '2026-01-04', 14), 13);
  assert.equal(dayIndex('2026-01-05', '2026-01-19', 14), 0);
});

test('detectCycle finds the smallest repeating unit', () => {
  assert.equal(detectCycle(['A', 'A', 'B', 'B', 'A', 'A', 'B', 'B']), 4);
  assert.equal(detectCycle(['A', 'B', 'C']), 3);
  assert.equal(detectCycle(['A', 'A', 'A', 'A']), 1);
});

test('softColor adds alpha to #rrggbb and passes others through', () => {
  assert.equal(softColor('#2d6a9f'), '#2d6a9f22');
  assert.equal(softColor('rebeccapurple'), 'rebeccapurple');
});

test('initials returns the uppercased first letter', () => {
  assert.equal(initials('mom'), 'M');
  assert.equal(initials(''), '?');
});

test('ymdLocal formats a local date, zero-padded, round-tripping with parseYmd', () => {
  assert.equal(ymdLocal(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(ymdLocal(new Date(2026, 11, 31)), '2026-12-31');
  assert.equal(ymdLocal(parseYmd('2026-01-05')), '2026-01-05');
});

test('eachDay visits every day of an inclusive range, in order, with indices', () => {
  const seen = [];
  eachDay('2026-01-30', '2026-02-02', (ds, i) => seen.push([ds, i]));
  assert.deepEqual(seen, [
    ['2026-01-30', 0],
    ['2026-01-31', 1],
    ['2026-02-01', 2],
    ['2026-02-02', 3],
  ]);
});

test('eachDay covers a US spring-forward DST boundary without dropping the last day', () => {
  // 2026-03-08 is the US spring-forward date; in a DST zone the naive Date<=end loop
  // could drop the final day. Count and endpoints must be exact regardless of local TZ.
  // (Only meaningful when the test runs in a DST-observing zone — vacuous under TZ=UTC.)
  const seen = [];
  eachDay('2026-03-07', '2026-03-09', (ds) => seen.push(ds));
  assert.deepEqual(seen, ['2026-03-07', '2026-03-08', '2026-03-09']);
});

test('eachDay covers a US fall-back DST boundary without adding a phantom day', () => {
  // 2026-11-01 is the US fall-back date (25-hour day) — the round-UP hazard, symmetric
  // to spring-forward's round-down.
  const seen = [];
  eachDay('2026-10-31', '2026-11-02', (ds) => seen.push(ds));
  assert.deepEqual(seen, ['2026-10-31', '2026-11-01', '2026-11-02']);
});

test('eachDay iterates zero times on reversed, empty, or invalid ranges', () => {
  let calls = 0;
  const count = () => (calls += 1);
  eachDay('2026-01-05', '2026-01-04', count);
  eachDay('', '', count);
  eachDay('not-a-date', '2026-01-05', count);
  assert.equal(calls, 0);
});

test('eachDay single-day range visits exactly that day', () => {
  const seen = [];
  eachDay('2026-06-15', '2026-06-15', (ds, i) => seen.push([ds, i]));
  assert.deepEqual(seen, [['2026-06-15', 0]]);
});

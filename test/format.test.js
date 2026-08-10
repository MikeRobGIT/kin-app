import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtRecorded, defaultEventTime } from '../lib/format.js';

test('fmtRecorded converts a stored UTC string to local time', () => {
  // 03:58 UTC on the 13th is 23:58 on the 12th in America/New_York (EDT).
  const out = fmtRecorded('2026-06-13 03:58:27', 'America/New_York');
  assert.match(out, /Jun 12, 2026/);
  assert.match(out, /11:58/);
});

test('fmtRecorded is empty for empty input and echoes garbage', () => {
  assert.equal(fmtRecorded('', 'America/New_York'), '');
  assert.equal(fmtRecorded('not-a-date', 'America/New_York'), 'not-a-date');
});

test('defaultEventTime rounds to the nearest visible hour slot', () => {
  assert.equal(defaultEventTime(new Date(2026, 0, 1, 14, 20)), '14:00'); // round down
  assert.equal(defaultEventTime(new Date(2026, 0, 1, 14, 37)), '15:00'); // round up
  assert.equal(defaultEventTime(new Date(2026, 0, 1, 9, 30)), '10:00'); // :30 rounds up
});

test('defaultEventTime clamps to the [lo, hi] slot range', () => {
  assert.equal(defaultEventTime(new Date(2026, 0, 1, 3, 0)), '06:00'); // before first slot
  assert.equal(defaultEventTime(new Date(2026, 0, 1, 23, 0)), '20:00'); // after last slot
  assert.equal(defaultEventTime(new Date(2026, 0, 1, 20, 40)), '20:00'); // round-up past hi clamps
});

test('defaultEventTime honors custom bounds', () => {
  assert.equal(defaultEventTime(new Date(2026, 0, 1, 5, 0), 7, 19), '07:00');
  assert.equal(defaultEventTime(new Date(2026, 0, 1, 21, 0), 7, 19), '19:00');
});

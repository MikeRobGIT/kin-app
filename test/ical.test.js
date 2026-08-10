import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs } from '../lib/ical.js';

// Build a valid .ics from lines (RFC 5545 wants CRLF; ical.js tolerates LF, but we send CRLF).
const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//kin//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');

const CONCRETE = ics(
  'BEGIN:VEVENT',
  'UID:game-1@kin',
  'SUMMARY:Game vs Rivals',
  'DTSTART:20260808T090000',
  'DTEND:20260808T110000',
  'LOCATION:Home Field',
  'END:VEVENT'
);

const WEEKLY = ics(
  'BEGIN:VEVENT',
  'UID:practice@kin',
  'SUMMARY:Weekly Practice',
  'DTSTART:20260810T173000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3',
  'END:VEVENT'
);

const win = { from: '2026-01-01', to: '2026-12-31' };

test('concrete VEVENT → one occurrence with wall-clock date/time, uid, location as notes', () => {
  const occ = parseIcs(CONCRETE, win);
  assert.equal(occ.length, 1);
  assert.deepEqual(occ[0], {
    uid: 'game-1@kin',
    title: 'Game vs Rivals',
    date: '2026-08-08',
    time: '09:00',
    allDay: false,
    notes: 'Home Field',
  });
});

test('weekly RRULE with COUNT=3 → three Mondays at the authored time, sharing the UID', () => {
  const occ = parseIcs(WEEKLY, win);
  assert.deepEqual(occ.map((o) => o.date), ['2026-08-10', '2026-08-17', '2026-08-24']);
  assert.ok(occ.every((o) => o.time === '17:30' && o.uid === 'practice@kin'));
});

test('cap bounds an open-ended weekly rule', () => {
  const infinite = ics(
    'BEGIN:VEVENT',
    'UID:forever@kin',
    'SUMMARY:Forever',
    'DTSTART:20260810T173000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO',
    'END:VEVENT'
  );
  const occ = parseIcs(infinite, { from: '2026-01-01', to: '2030-12-31', cap: 2 });
  assert.equal(occ.length, 2);
});

test('the [from, to] window excludes out-of-range occurrences', () => {
  // Same feed, window that only covers the first two Mondays.
  const occ = parseIcs(WEEKLY, { from: '2026-08-01', to: '2026-08-18' });
  assert.deepEqual(occ.map((o) => o.date), ['2026-08-10', '2026-08-17']);
});

test('all-day DATE event → allDay true, default 08:00 time', () => {
  const allday = ics('BEGIN:VEVENT', 'UID:ad@kin', 'SUMMARY:Tournament', 'DTSTART;VALUE=DATE:20260808', 'END:VEVENT');
  const occ = parseIcs(allday, win);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].allDay, true);
  assert.equal(occ[0].time, '08:00');
  assert.equal(occ[0].date, '2026-08-08');
});

test('malformed input throws (caller surfaces a parse error)', () => {
  assert.throws(() => parseIcs('not a calendar', win));
});

// These run with NEXT_PUBLIC_TZ unset, so lib/ical.js uses its documented default (America/New_York)
// — independent of the process zone. test/ical-tz.test.js proves that independence explicitly.
test('a UTC-only DTSTART is converted to the local zone, not read as wall-clock', () => {
  // The real Cobb County rec1.com feed: DTSTART:...143000Z, no VTIMEZONE, for a class its own
  // SUMMARY calls "Sat 10:30 am". Read as authored wall-clock it imported 4 hours late.
  const utc = ics(
    'BEGIN:VEVENT',
    'UID:rec1@kin',
    'SUMMARY:Minnows (3yr-5yr) - WCAC Sat 10:30 am',
    'DTSTART:20260815T143000Z',
    'END:VEVENT'
  );
  const occ = parseIcs(utc, win);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].date, '2026-08-15');
  assert.equal(occ[0].time, '10:30'); // 14:30Z → 10:30 EDT
});

test('a floating DTSTART still lands as its authored wall-clock', () => {
  // No Z and no TZID means "9:00 on the game's calendar" — converting it would be wrong.
  assert.equal(parseIcs(CONCRETE, win)[0].time, '09:00');
});

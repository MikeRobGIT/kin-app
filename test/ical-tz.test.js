import { test } from 'node:test';
import assert from 'node:assert/strict';

// A deployed container never sets TZ (nothing in Dockerfile / docker-compose.yml /
// docker-entrypoint.sh does), so it runs UTC — reading the PROCESS zone would silently import every
// absolute event at the wrong time in production. lib/ical.js must use the CONFIGURED zone
// (NEXT_PUBLIC_TZ, via lib/format.js RECORDED_TZ) instead.
//
// That constant is resolved once at module load, so this file pins one zone for the whole process
// and deliberately picks America/Los_Angeles: 07:30 is a time NEITHER plausible process zone would
// produce (UTC would give 14:30, CI's America/New_York 10:30), so the assertion can only pass if the
// configured zone is what's being used. `node --test` runs each file in its own process, so the env
// set here can't leak into test/ical.test.js (which covers the default-zone path).
process.env.NEXT_PUBLIC_TZ = 'America/Los_Angeles';

const ics = (...lines) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//kin//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');

// The real rec1.com shape: a UTC instant, no VTIMEZONE, for a class its SUMMARY calls "Sat 10:30 am".
const UTC_FEED = ics(
  'BEGIN:VEVENT',
  'UID:rec1@kin',
  'SUMMARY:Minnows (3yr-5yr) - WCAC Sat 10:30 am',
  'DTSTART:20260815T143000Z',
  'END:VEVENT'
);

// ical.js only resolves a TZID when the feed ships the matching VTIMEZONE; without one the time
// falls back to floating and is read as authored wall-clock. This fixture ships it, so the event is
// a genuine instant — 09:00 America/New_York — and must be converted like any other.
const TZID_FEED = ics(
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:tzid@kin',
  'SUMMARY:Practice',
  'DTSTART;TZID=America/New_York:20260815T090000',
  'END:VEVENT'
);

const FLOATING = ics(
  'BEGIN:VEVENT',
  'UID:float@kin',
  'SUMMARY:Practice',
  'DTSTART:20260815T090000',
  'END:VEVENT'
);

const win = { from: '2026-01-01', to: '2026-12-31' };
const parse = async (text) => (await import('../lib/ical.js')).parseIcs(text, win);

test('a UTC DTSTART converts into the configured zone, not the process zone', async () => {
  const occ = await parse(UTC_FEED);
  assert.equal(occ[0].date, '2026-08-15');
  assert.equal(occ[0].time, '07:30'); // 14:30Z → 07:30 PDT
});

test('a TZID DTSTART is converted too — it is an instant, not wall-clock', async () => {
  const occ = await parse(TZID_FEED);
  assert.equal(occ[0].time, '06:00'); // 09:00 America/New_York → 06:00 PDT
});

test('a floating DTSTART is never converted, whatever the configured zone', async () => {
  const occ = await parse(FLOATING);
  assert.equal(occ[0].time, '09:00'); // authored wall-clock, untouched
  assert.equal(occ[0].date, '2026-08-15');
});

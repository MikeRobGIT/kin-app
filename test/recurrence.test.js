import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRecurrence, expandDates, normWeekdays, MAX_OCCURRENCES } from '../lib/recurrence.js';

const dow = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};

test('weekly Tue+Thu until-date keeps only those weekdays, inclusive', () => {
  // 2026-06-01 is a Monday; range through 2026-06-14 (two weeks).
  const { dates, truncated } = expandRecurrence({
    weekdays: ['tue', 'thu'],
    from: '2026-06-01',
    until: '2026-06-14',
  });
  assert.equal(truncated, false);
  assert.deepEqual(dates, ['2026-06-02', '2026-06-04', '2026-06-09', '2026-06-11']);
  assert.ok(dates.every((d) => dow(d) === 2 || dow(d) === 4));
});

test('start date is included when its weekday is selected', () => {
  const { dates } = expandRecurrence({ weekdays: ['mon'], from: '2026-06-01', until: '2026-06-15' });
  assert.deepEqual(dates, ['2026-06-01', '2026-06-08', '2026-06-15']);
});

test('interval=2 skips alternate weeks (every other week)', () => {
  // Tuesdays every 2 weeks starting the week of Mon 2026-06-01.
  const { dates } = expandRecurrence({
    weekdays: ['tue'],
    from: '2026-06-01',
    interval: 2,
    until: '2026-07-15',
  });
  // Week0: 06-02, skip week1 (06-09), week2: 06-16, skip, week4: 06-30, skip, week6: 07-14
  assert.deepEqual(dates, ['2026-06-02', '2026-06-16', '2026-06-30', '2026-07-14']);
});

test('count-based end yields exactly N occurrences', () => {
  const { dates, truncated } = expandRecurrence({
    weekdays: ['tue', 'thu'],
    from: '2026-06-01',
    count: 5,
  });
  assert.equal(dates.length, 5);
  assert.equal(truncated, false);
  assert.deepEqual(dates, ['2026-06-02', '2026-06-04', '2026-06-09', '2026-06-11', '2026-06-16']);
});

test('count with interval spaces occurrences across weeks', () => {
  const { dates } = expandRecurrence({ weekdays: ['wed'], from: '2026-06-03', interval: 2, count: 3 });
  // 06-03 is a Wednesday. Every 2 weeks: 06-03, 06-17, 07-01.
  assert.deepEqual(dates, ['2026-06-03', '2026-06-17', '2026-07-01']);
});

test('empty / invalid weekdays produce no dates', () => {
  assert.deepEqual(expandRecurrence({ weekdays: [], from: '2026-06-01', until: '2026-06-30' }).dates, []);
  assert.deepEqual(expandRecurrence({ weekdays: ['xxx'], from: '2026-06-01', count: 5 }).dates, []);
});

test('until before from yields nothing', () => {
  assert.deepEqual(
    expandRecurrence({ weekdays: ['mon'], from: '2026-06-10', until: '2026-06-01' }).dates,
    []
  );
});

test('an absurd daily range is capped at MAX_OCCURRENCES and flagged truncated', () => {
  const { dates, truncated } = expandRecurrence({
    weekdays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    from: '2020-01-01',
    until: '2030-01-01',
  });
  assert.equal(dates.length, MAX_OCCURRENCES);
  assert.equal(truncated, true);
});

test('count is capped at MAX_OCCURRENCES', () => {
  const { dates } = expandRecurrence({
    weekdays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    from: '2026-01-01',
    count: 10000,
  });
  assert.equal(dates.length, MAX_OCCURRENCES);
});

test('spring-forward DST week neither drops nor duplicates a day', () => {
  // US DST 2026 begins Sun 2026-03-08. Daily across it must be contiguous with no dup.
  const { dates } = expandRecurrence({
    weekdays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    from: '2026-03-06',
    until: '2026-03-10',
  });
  assert.deepEqual(dates, ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
});

test('a pathological interval is capped so expansion stays bounded (no runaway loop)', () => {
  const { dates } = expandRecurrence({ weekdays: ['mon'], from: '2026-01-05', interval: 1e9, count: 5 });
  assert.ok(dates.length >= 1 && dates.length <= 5, `bounded, got ${dates.length}`);
  assert.equal(dates[0], '2026-01-05'); // the from-week Monday is always the first occurrence
});

test('normWeekdays lowercases, truncates to 3, drops junk', () => {
  assert.deepEqual(normWeekdays(['Tuesday', 'THU', 'x', 5]), ['tue', 'thu']);
  assert.deepEqual(normWeekdays(null), []);
});

test('expandDates back-compat wrapper matches until-date expansion', () => {
  assert.deepEqual(
    expandDates(['fri'], '2026-06-01', '2026-06-30').dates,
    ['2026-06-05', '2026-06-12', '2026-06-19', '2026-06-26']
  );
});

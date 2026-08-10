import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLIDAYS, holidayRange, nextHolidayRange } from '../lib/holidays.js';

test('HOLIDAYS exposes keyed, labelled options', () => {
  assert.ok(HOLIDAYS.length >= 12);
  assert.ok(HOLIDAYS.every((h) => h.key && h.label));
  assert.ok(HOLIDAYS.find((h) => h.key === 'christmas' && /Christmas/.test(h.label)));
  assert.ok(HOLIDAYS.find((h) => h.key === 'thanksgiving_break'));
});

test('fixed-date holidays', () => {
  assert.deepEqual(holidayRange('christmas', 2026), {
    label: 'Christmas Day', from: '2026-12-25', to: '2026-12-25',
  });
  assert.equal(holidayRange('independence_day', 2026).from, '2026-07-04');
  assert.equal(holidayRange('juneteenth', 2026).from, '2026-06-19');
  assert.equal(holidayRange('new_years', 2026).from, '2026-01-01');
});

test('floating nth-weekday holidays (2026)', () => {
  assert.equal(holidayRange('thanksgiving', 2026).from, '2026-11-26'); // 4th Thu Nov
  assert.equal(holidayRange('mlk', 2026).from, '2026-01-19'); // 3rd Mon Jan
  assert.equal(holidayRange('presidents', 2026).from, '2026-02-16'); // 3rd Mon Feb
  assert.equal(holidayRange('memorial', 2026).from, '2026-05-25'); // last Mon May
  assert.equal(holidayRange('labor', 2026).from, '2026-09-07'); // 1st Mon Sep
  assert.equal(holidayRange('columbus', 2026).from, '2026-10-12'); // 2nd Mon Oct
});

test('multi-day breaks (2026)', () => {
  assert.deepEqual(holidayRange('thanksgiving_break', 2026), {
    label: 'Thanksgiving break', from: '2026-11-25', to: '2026-11-29', // Wed → Sun
  });
  assert.deepEqual(holidayRange('winter_break', 2026), {
    label: 'Winter break', from: '2026-12-23', to: '2027-01-01', // spans the year boundary
  });
});

test('Easter weekend 2026 = Good Friday Apr 3 → Easter Sunday Apr 5', () => {
  assert.deepEqual(holidayRange('easter', 2026), {
    label: 'Easter weekend', from: '2026-04-03', to: '2026-04-05',
  });
});

test('nextHolidayRange rolls to next year once the range has passed', () => {
  // today 2026-07-19: July 4 already passed → 2027; Christmas still upcoming → 2026.
  assert.equal(nextHolidayRange('independence_day', '2026-07-19').from, '2027-07-04');
  assert.equal(nextHolidayRange('christmas', '2026-07-19').from, '2026-12-25');
  assert.equal(nextHolidayRange('new_years', '2026-07-19').from, '2027-01-01');
  // a range still in progress (winter break, if today were inside it) stays on the current year.
  assert.equal(nextHolidayRange('winter_break', '2026-12-28').to, '2027-01-01');
  // ON the holiday's last day it must NOT roll (strict `to < today`).
  assert.equal(nextHolidayRange('independence_day', '2026-07-04').from, '2026-07-04');
});

test('Easter for a second year guards the Gregorian algorithm (2027 = Mar 28)', () => {
  assert.deepEqual(holidayRange('easter', 2027), {
    label: 'Easter weekend', from: '2027-03-26', to: '2027-03-28',
  });
});

test('an unknown key yields null (not a throw)', () => {
  assert.equal(holidayRange('bogus', 2026), null);
  assert.equal(nextHolidayRange('bogus', '2026-07-19'), null);
});

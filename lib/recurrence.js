// Pure recurrence expansion — weekly on chosen weekdays, every `interval` weeks, ending
// either by an until-date or after `count` occurrences. Materializes a concrete date list
// the caller turns into real event rows (the app stores occurrences, never an RRULE).
// No node/db deps, so it is safe to import from the client component too
// (lib/schedule.js is likewise pure).

import { ymdLocal } from './schedule.js';

export const WEEKDAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
export const MAX_OCCURRENCES = 366; // matches the /api/events/bulk cap
const CAP_INTERVAL = 100; // clamp the week interval so a pathological value can't blow up the scan

const MS_PER_DAY = 86400000;
const parseLocal = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d); // local midnight — avoids UTC drift
};
// The local date `i` whole days after `start`. Built fresh from Y/M/D each call and advanced
// by an integer day count, so a midnight-DST shift can't drop or duplicate a day (kin.md rule).
const dayOf = (start, i) => {
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  d.setDate(d.getDate() + i);
  return d;
};

export const normWeekdays = (ws) =>
  (Array.isArray(ws) ? ws : [])
    .map((w) => String(w).slice(0, 3).toLowerCase())
    .filter((w) => w in WEEKDAY_IDX);

// { weekdays, from, interval=1, until=null, count=null } -> { dates:[YYYY-MM-DD], truncated }.
// interval N: occurrences fall in the week containing `from` (week 0) and every Nth week after,
// weeks anchored Sun-Sat on `from`'s week. Provide EITHER until (inclusive end date) OR count.
export function expandRecurrence({ weekdays, from, interval = 1, until = null, count = null }) {
  const want = new Set(normWeekdays(weekdays).map((w) => WEEKDAY_IDX[w]));
  if (!want.size || !from) return { dates: [], truncated: false };
  const step = Number.isInteger(interval) && interval >= 1 ? Math.min(interval, CAP_INTERVAL) : 1;
  const start = parseLocal(from);
  const fromDow = start.getDay(); // offset of `from` into its Sun-anchored week
  // Absolute scan ceiling for both branches: a sparse rule (few weekdays, big interval) over a
  // huge range must never spin the event loop. MAX matches are always reached well before this.
  const HARD_SCAN = MAX_OCCURRENCES * 7 * step;

  const dates = [];
  let truncated = false;
  const push = (d) => {
    if (dates.length >= MAX_OCCURRENCES) {
      truncated = true;
      return false;
    }
    dates.push(ymdLocal(d));
    return true;
  };
  const inActiveWeek = (i) => Math.floor((i + fromDow) / 7) % step === 0;

  if (until != null && until !== '') {
    const span = Math.min(Math.round((parseLocal(until) - start) / MS_PER_DAY), HARD_SCAN);
    if (span < 0) return { dates: [], truncated: false };
    for (let i = 0; i <= span; i++) {
      if (!inActiveWeek(i)) continue;
      const d = dayOf(start, i);
      if (want.has(d.getDay()) && !push(d)) break;
    }
    return { dates, truncated };
  }

  const target = Math.min(Math.max(Number(count) | 0, 0), MAX_OCCURRENCES);
  if (!target) return { dates: [], truncated: false };
  const scanMax = Math.min(target * 7 * step + 14, HARD_SCAN); // even 1 weekday/week terminates
  for (let i = 0; i <= scanMax && dates.length < target; i++) {
    if (!inActiveWeek(i)) continue;
    const d = dayOf(start, i);
    if (want.has(d.getDay())) push(d);
  }
  return { dates, truncated };
}

// Back-compat helper for the AI parse route: weekly on weekdays, inclusive from..to.
export function expandDates(weekdays, from, to) {
  return expandRecurrence({ weekdays, from, until: to });
}

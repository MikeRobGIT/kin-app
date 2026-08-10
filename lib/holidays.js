import { ymdLocal } from './schedule.js';

// Common US holidays for the parent-time override picker. Pure + local-date based (matches the
// app's date handling): every Date is constructed local (`new Date(y, m, d)`) and formatted with
// ymdLocal, so it round-trips regardless of timezone and never crosses into UTC.
//
// Multi-day "break" ranges (Thanksgiving/Winter/Spring) are sensible defaults — school districts
// vary — and stay editable in the From/To fields after selection.

// nth (1-based) `weekday` (0=Sun..6=Sat) of month `m` (0-based) in `year`.
function nthWeekday(year, m, weekday, n) {
  const first = new Date(year, m, 1).getDay();
  const offset = (weekday - first + 7) % 7; // days from the 1st to the first `weekday`
  return new Date(year, m, 1 + offset + (n - 1) * 7);
}

// last `weekday` of month `m`.
function lastWeekday(year, m, weekday) {
  const last = new Date(year, m + 1, 0); // day 0 of next month = last day of `m`
  const back = (last.getDay() - weekday + 7) % 7;
  return new Date(year, m + 1, -back);
}

// Easter Sunday via the anonymous Gregorian algorithm. Returns a local Date.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mth = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mth + 114) / 31); // 3=March, 4=April
  const day = ((h + l - 7 * mth + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const single = (label, d) => ({ label, from: ymdLocal(d), to: ymdLocal(d) });
const range = (label, a, b) => ({ label, from: ymdLocal(a), to: ymdLocal(b) });

// key → (year) => { label, from, to }
const BUILDERS = {
  new_years: (y) => single("New Year's Day", new Date(y, 0, 1)),
  mlk: (y) => single('MLK Day', nthWeekday(y, 0, 1, 3)),
  presidents: (y) => single("Presidents' Day", nthWeekday(y, 1, 1, 3)),
  easter: (y) => {
    const es = easterSunday(y);
    return range('Easter weekend', addDays(es, -2), es); // Good Friday → Easter Sunday
  },
  spring_break: (y) => {
    const mon = nthWeekday(y, 2, 1, 3); // 3rd Monday of March — a rough, editable default
    return range('Spring break', mon, addDays(mon, 6));
  },
  memorial: (y) => single('Memorial Day', lastWeekday(y, 4, 1)),
  juneteenth: (y) => single('Juneteenth', new Date(y, 5, 19)),
  independence_day: (y) => single('Independence Day', new Date(y, 6, 4)),
  labor: (y) => single('Labor Day', nthWeekday(y, 8, 1, 1)),
  columbus: (y) => single("Columbus / Indigenous Peoples' Day", nthWeekday(y, 9, 1, 2)),
  veterans: (y) => single('Veterans Day', new Date(y, 10, 11)),
  thanksgiving: (y) => single('Thanksgiving Day', nthWeekday(y, 10, 4, 4)),
  thanksgiving_break: (y) => {
    const th = nthWeekday(y, 10, 4, 4);
    return range('Thanksgiving break', addDays(th, -1), addDays(th, 3)); // Wed before → Sun after
  },
  winter_break: (y) => range('Winter break', new Date(y, 11, 23), new Date(y + 1, 0, 1)),
  christmas: (y) => single('Christmas Day', new Date(y, 11, 25)),
};

// Picker options, chronological by first occurrence. Labels are year-independent.
export const HOLIDAYS = [
  'new_years', 'mlk', 'presidents', 'easter', 'spring_break', 'memorial', 'juneteenth',
  'independence_day', 'labor', 'columbus', 'veterans', 'thanksgiving', 'thanksgiving_break',
  'winter_break', 'christmas',
].map((key) => ({ key, label: BUILDERS[key](2000).label }));

// The holiday's { label, from, to } (YYYY-MM-DD) for a specific calendar year, or null.
export function holidayRange(key, year) {
  const b = BUILDERS[key];
  return b ? b(year) : null;
}

// The NEXT occurrence relative to `todayYmd` (YYYY-MM-DD): this year's, or next year's if this
// year's range has already ended. YYYY-MM-DD strings compare chronologically. Boundary note:
// winter_break spans Dec y → Jan y+1, so on Jan 1 (its last day) this returns NEXT December's
// break rather than the one ending today — acceptable (last day only, and dates are editable).
export function nextHolidayRange(key, todayYmd) {
  const y = Number(todayYmd.slice(0, 4));
  let r = holidayRange(key, y);
  if (!r) return null;
  if (r.to < todayYmd) r = holidayRange(key, y + 1);
  return r;
}

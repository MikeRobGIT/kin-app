// Pure parent-time schedule engine. No DB, no React — safe to import on the server,
// in the client bundle, and in tests. A schedule is a repeating N-day cycle of parent
// assignments anchored to a date; date-range overrides win for the days they cover.

const MS_PER_DAY = 86400000;

// Preset patterns use 'A'/'B' tokens; resolvePreset maps them to two caregiver ids.
// Patterns are Monday-first (cycle day 0 = Monday). The manager previews the next 14
// days so the user confirms anchor/weekend alignment before saving.
export const PRESETS = {
  week_on_off: {
    label: 'Week on / week off',
    cycleLen: 14,
    pattern: ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'B', 'B', 'B'],
  },
  two_two_three: {
    label: '2-2-3',
    cycleLen: 14,
    pattern: ['A', 'A', 'B', 'B', 'A', 'A', 'A', 'B', 'B', 'A', 'A', 'B', 'B', 'B'],
  },
  two_two_five_five: {
    label: '2-2-5-5',
    cycleLen: 14,
    pattern: ['A', 'A', 'B', 'B', 'A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'B'],
  },
  three_four_four_three: {
    label: '3-4-4-3',
    cycleLen: 14,
    pattern: ['A', 'A', 'A', 'B', 'B', 'B', 'B', 'A', 'A', 'A', 'A', 'B', 'B', 'B'],
  },
  alt_two: {
    label: 'Alternating every 2 days',
    cycleLen: 4,
    pattern: ['A', 'A', 'B', 'B'],
  },
  every_other_weekend: {
    label: 'Every other weekend',
    cycleLen: 14,
    pattern: ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'A', 'A', 'A', 'A', 'A', 'A', 'A'],
  },
};

export const PRESET_KEYS = [...Object.keys(PRESETS), 'custom'];

// Parse YYYY-MM-DD as a LOCAL calendar date (matches Calendar.js parseYmd) — avoids
// UTC/timezone drift in day arithmetic.
export function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Whole days from anchor to date (may be negative), folded into [0, cycleLen).
export function dayIndex(anchorYmd, ymd, cycleLen) {
  const diff = Math.round((parseYmd(ymd) - parseYmd(anchorYmd)) / MS_PER_DAY);
  return ((diff % cycleLen) + cycleLen) % cycleLen;
}

// Map a preset's A/B pattern onto two caregiver ids; null for unknown keys.
export function resolvePreset(key, aId, bId) {
  const p = PRESETS[key];
  if (!p) return null;
  return p.pattern.map((slot) => (slot === 'A' ? aId : bId));
}

// { count: {id:n}, total, pct: {id:%} } for an assignment array of caregiver ids.
export function splitPercent(assignment) {
  const list = Array.isArray(assignment) ? assignment : [];
  const count = {};
  for (const id of list) count[id] = (count[id] || 0) + 1;
  const total = list.length || 1;
  const pct = {};
  for (const id of Object.keys(count)) pct[id] = Math.round((count[id] / total) * 100);
  return { count, total: list.length, pct };
}

// Smallest repeating unit length of an array (for custom schedules); arr.length when
// nothing shorter repeats cleanly.
export function detectCycle(arr) {
  const n = arr.length;
  for (let len = 1; len <= n; len++) {
    if (n % len !== 0) continue;
    let ok = true;
    for (let i = len; i < n; i++) {
      if (arr[i] !== arr[i % len]) {
        ok = false;
        break;
      }
    }
    if (ok) return len;
  }
  return n;
}

// Inclusive range test. Lexicographic comparison is correct for zero-padded YYYY-MM-DD.
function inRange(d, from, to) {
  return from <= d && d <= to;
}

// The caregiver_id on duty for date `ymd`, or null if nothing covers it.
// Precedence: a covering override (latest created_at) beats the base. Among base
// schedules covering the date, a fully-bounded segment beats an open-ended one;
// tiebreak by latest starts_on, then latest created_at.
export function parentOnDate(ymd, schedules = [], overrides = []) {
  const ov = overrides
    .filter((o) => inRange(ymd, o.date_from, o.date_to))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (ov) return ov.caregiver_id;

  const active = schedules.filter(
    (s) =>
      (s.starts_on == null || s.starts_on <= ymd) &&
      (s.ends_on == null || s.ends_on >= ymd)
  );
  if (!active.length) return null;

  active.sort((a, b) => {
    const aBounded = a.starts_on != null && a.ends_on != null;
    const bBounded = b.starts_on != null && b.ends_on != null;
    if (aBounded !== bBounded) return aBounded ? -1 : 1; // bounded segment first
    const sa = a.starts_on || '';
    const sb = b.starts_on || '';
    if (sa !== sb) return sb.localeCompare(sa); // latest starts_on first
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });

  const s = active[0];
  const assignment = Array.isArray(s.assignment) ? s.assignment : JSON.parse(s.assignment);
  if (!assignment.length) return null;
  return assignment[dayIndex(s.anchor_date, ymd, s.cycle_len)];
}

// Format a Date as local-time YYYY-MM-DD (inverse of parseYmd — never toISOString,
// which shifts across the UTC boundary).
export function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

// Call fn(ymd, i) for each day of the inclusive [from, to] range. Loops by integer day
// offset (DST-safe via Math.round, matching dayIndex) instead of comparing Date objects —
// a midnight-DST shift could otherwise drop the last day. Bad/empty or reversed ranges
// iterate zero times.
export function eachDay(from, to, fn) {
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (!(start <= end)) return;
  const days = Math.round((end - start) / MS_PER_DAY) + 1; // inclusive
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    fn(ymdLocal(d), i);
  }
}

// Count overnights per caregiver across the inclusive [from, to] date range, attributing
// each night to whoever parentOnDate puts on duty that date (parent-time schedule + overrides
// — no event rows). Returns { counts: {caregiver_id: n}, unassigned, total }. Bad/empty or
// reversed ranges return zeros.
export function overnightCounts(from, to, schedules = [], overrides = []) {
  const counts = {};
  let unassigned = 0;
  let total = 0;
  eachDay(from, to, (ds) => {
    const id = parentOnDate(ds, schedules, overrides);
    total += 1;
    if (id) counts[id] = (counts[id] || 0) + 1;
    else unassigned += 1;
  });
  return { counts, unassigned, total };
}

// A soft, translucent version of a #rrggbb color, for background bands/tints.
export function softColor(hex) {
  return typeof hex === 'string' && hex.length === 7 ? hex + '22' : hex;
}

// First letter, uppercased — for the month-cell parent badge.
export function initials(name) {
  return name ? String(name).trim().charAt(0).toUpperCase() : '?';
}

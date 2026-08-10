// Default display timezone for "Recorded" timestamps. Override at build time with
// NEXT_PUBLIC_TZ (inlined into the client bundle).
export const RECORDED_TZ = process.env.NEXT_PUBLIC_TZ || 'America/New_York';

// SQLite datetime('now') stores 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker.
// Render it in the configured local zone so a late-evening entry doesn't appear
// on the next calendar day.
export function fmtRecorded(s, tz = RECORDED_TZ) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Default 'HH:00' for a new event with no chosen slot: the current time rounded to the
// nearest visible hour, clamped to the calendar's [lo, hi] slot range. Replaces the old
// hardcoded 08:00 so "+ Add Event" lands near now.
export function defaultEventTime(d = new Date(), lo = 6, hi = 20) {
  let h = d.getHours() + (d.getMinutes() >= 30 ? 1 : 0);
  h = Math.min(hi, Math.max(lo, h));
  return `${String(h).padStart(2, '0')}:00`;
}

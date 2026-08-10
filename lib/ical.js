// Pure iCalendar (.ics) parser: turns a feed's VEVENTs into concrete occurrences the sync route
// maps to Kin event rows. No node/db deps — safe to unit-test in isolation. Wraps ical.js (RFC 5545)
// for correct RRULE/EXDATE expansion; Kin still stores materialized occurrences, never an RRULE.
import ICAL from 'ical.js';
import { RECORDED_TZ } from './format.js';

const pad = (n) => String(n).padStart(2, '0');
export const MAX_PER_EVENT = 366; // matches lib/recurrence.js MAX_OCCURRENCES / the bulk cap

// The family's zone, resolved once. This is RECORDED_TZ (NEXT_PUBLIC_TZ) — the same setting the rest
// of the app formats with — and NOT the process zone: nothing in Dockerfile / docker-compose.yml /
// docker-entrypoint.sh sets TZ, so a deployed container runs UTC. Reading local Date getters would
// therefore leave a 14:30Z event at 14:30 in production and push a TZID-authored 09:00 to 13:00.
// A malformed NEXT_PUBLIC_TZ falls back to the documented default rather than throwing mid-sync
// (which the route would surface as a misleading "Could not parse calendar").
const ZONE = (() => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: RECORDED_TZ });
    return RECORDED_TZ;
  } catch {
    return 'America/New_York';
  }
})();
const zoneFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// Read an ICAL.Time as the family's wall-clock, which is what Kin stores. Three cases, and the
// distinction matters:
//
//   all-day (VALUE=DATE) — a calendar date, not an instant. Never converted.
//   floating (no TZID and no trailing Z) — ALREADY authored wall-clock: "9:00 on the game's
//     calendar" must land as 09:00 whatever zone anything runs in.
//   absolute (trailing Z, or a real TZID) — a true instant, so it MUST be converted into ZONE or it
//     lands off by the UTC offset.
//
// That last case is not hypothetical: the Cobb County rec1.com feed emits DTSTART:20260815T143000Z
// with no VTIMEZONE for a class its own SUMMARY calls "Sat 10:30 am" — read as authored wall-clock
// it imported 4 hours late.
function localParts(t) {
  const floating = t.isDate || !t.zone || t.zone === ICAL.Timezone.localTimezone;
  if (floating) return { y: t.year, mo: t.month, d: t.day, h: t.hour, mi: t.minute };
  const p = {};
  for (const { type, value } of zoneFmt.formatToParts(t.toJSDate())) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
const ymd = (p) => `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
const hm = (p) => `${pad(p.h)}:${pad(p.mi)}`;

// Parse `text` into occurrences [{ uid, title, date, time, allDay, notes }], each a concrete day.
// Recurring VEVENTs are expanded and bounded to [from, to] (YYYY-MM-DD) with at most `cap` occurrences
// per VEVENT. `from`/`to` are a coarse window (the caller passes a generous ±range), so exact
// boundary-day precision across zones doesn't matter. Throws on malformed input (caller catches).
export function parseIcs(text, { from, to, cap = MAX_PER_EVENT } = {}) {
  const comp = new ICAL.Component(ICAL.parse(text));
  const vevents = comp.getAllSubcomponents('vevent');
  const fromT = from ? ICAL.Time.fromDateString(from) : null;
  const toT = to ? ICAL.Time.fromDateString(to) : null;
  const out = [];

  for (const ve of vevents) {
    const event = new ICAL.Event(ve);
    if (!event.startDate) continue; // a VEVENT with no DTSTART has no place on a calendar
    const uid = event.uid || '';
    const title = String(event.summary || '').slice(0, 120);
    const notes = String(event.location || event.description || '').slice(0, 500);
    const push = (t) => {
      const allDay = !!t.isDate;
      const p = localParts(t);
      out.push({ uid, title, date: ymd(p), time: allDay ? '08:00' : hm(p), allDay, notes });
    };

    if (event.isRecurring()) {
      const it = event.iterator();
      let kept = 0;
      // Hard iteration ceiling: a years-old, open-ended (no UNTIL/COUNT) feed would otherwise spin
      // from DTSTART forward forever. We skip occurrences before the window, so the ceiling counts
      // ALL steps, not just kept ones.
      const maxSteps = cap * 40 + 2000;
      for (let i = 0, next = it.next(); next && kept < cap && i < maxSteps; i++, next = it.next()) {
        if (fromT && next.compare(fromT) < 0) continue; // before the window — keep advancing
        if (toT && next.compare(toT) > 0) break; // past the window — done with this rule
        push(event.getOccurrenceDetails(next).startDate);
        kept++;
      }
    } else {
      const s = event.startDate;
      const inWindow = (!fromT || s.compare(fromT) >= 0) && (!toT || s.compare(toT) <= 0);
      if (inWindow) push(s);
    }
  }
  return out;
}

import crypto from 'node:crypto';
import { parentOnDate } from './schedule.js';

// Monthly cryptographic seal (record-integrity capstone). Pure: no DB, no env.
//
// The canonical record of a month is its events (only the persisted fields, deterministically
// ordered) PLUS the per-night parent-on-duty attribution for that month — so the seal covers
// both the care log AND the custody split (IB-04) the report asserts. sha256 is the digest of
// that canonical JSON; hmac is HMAC-SHA256 of the same string keyed by AUTH_SECRET. Verifying
// recomputes both over the *current* data and compares — any change reads as a mismatch.
// NOTE: the hmac is tied to AUTH_SECRET; rotating that secret invalidates prior hmacs.

const pad2 = (n) => String(n).padStart(2, '0');

// Build the deterministic canonical string for `month` ('YYYY-MM'). Returns the string and
// the count of events that fell in the month.
export function canonicalMonth(month, events = [], schedules = [], overrides = []) {
  const evs = events
    .filter((e) => e && typeof e.date === 'string' && e.date.slice(0, 7) === month)
    .map((e) => ({
      id: e.id,
      date: e.date,
      time: e.time,
      type: e.type,
      child_id: e.child_id,
      caregiver_id: e.caregiver_id || null,
      // Conditionally sealed: present ONLY when a distinct pickup parent is set (trip pd='both').
      // Omitting the key when absent keeps every legacy row byte-identical to its pre-feature
      // serialization, so already-sealed months still verify; a set value is sealed going forward.
      ...(e.pickup_caregiver_id ? { pickup_caregiver_id: e.pickup_caregiver_id } : {}),
      pd: e.pd,
      title: e.title,
      who: e.who || '',
      notes: e.notes || '',
      // Seal the recorded/edited timestamps too — the report shows them, so an edit
      // (even one reverted to identical values) should register as a change.
      created_at: e.created_at || null,
      updated_at: e.updated_at || null,
    }))
    .sort((a, b) => (a.date + a.time + a.id).localeCompare(b.date + b.time + b.id));

  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate(); // last day of month m (m is 1-based here)
  const nights = [];
  for (let day = 1; day <= days; day++) {
    const ds = `${month}-${pad2(day)}`;
    nights.push([ds, parentOnDate(ds, schedules, overrides) || null]);
  }

  return { canonical: JSON.stringify({ v: 1, month, events: evs, nights }), eventCount: evs.length };
}

// Compute the seal digests for a month. Returns { sha256, hmac, event_count }.
export function sealMonth(month, events, schedules, overrides, secret) {
  const { canonical, eventCount } = canonicalMonth(month, events, schedules, overrides);
  const sha256 = crypto.createHash('sha256').update(canonical).digest('hex');
  const hmac = crypto.createHmac('sha256', String(secret ?? '')).update(canonical).digest('hex');
  return { sha256, hmac, event_count: eventCount };
}

// Recompute over current data and compare to a stored seal { month, sha256, hmac }.
// Returns { match, sha256, hmac, event_count } where match means the record is unchanged.
export function verifySeal(seal, events, schedules, overrides, secret) {
  const fresh = sealMonth(seal.month, events, schedules, overrides, secret);
  return {
    match: fresh.sha256 === seal.sha256 && fresh.hmac === seal.hmac,
    sha256: fresh.sha256,
    hmac: fresh.hmac,
    event_count: fresh.event_count,
  };
}

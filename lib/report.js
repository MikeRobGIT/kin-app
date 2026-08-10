import { TYPES, isTrip } from './constants.js';

// The involvement summary, computed once and shared by the authed report (components/Report.js)
// and the public lawyer share page (app/share/[token]) so the two can never show different
// numbers for the same data. Pure — buckets transport/care *trips* per caregiver and activity type.
//
// A two-leg trip (pd='both') that names a distinct pickup parent credits BOTH parents one trip each
// — the drop-off leg to caregiver_id, the pickup leg to pickup_caregiver_id. Every other event
// (non-trip, single-leg trip, or a legacy/same-parent 'both') stays one credit to caregiver_id, so
// pre-feature totals never shift. `grand` therefore counts trips (legs), which can exceed the number
// of event rows.

export const UNASSIGNED = '__unassigned__';

// The parent(s) credited for an event: two legs for a split 'both' trip whose pickup parent is set
// AND differs from the drop-off parent, else one. The distinctness guard mirrors the write layer
// (lib/event-writes.js normalize) so a same-parent 'both' counts once even if fed in un-normalized.
export function eventLegs(e) {
  return isTrip(e.type) && e.pd === 'both' && e.pickup_caregiver_id && e.pickup_caregiver_id !== e.caregiver_id
    ? [e.caregiver_id, e.pickup_caregiver_id]
    : [e.caregiver_id];
}

export function summarizeInvolvement(events, caregivers = []) {
  const buckets = {};
  const typeSet = new Set();
  let grand = 0;
  for (const e of events) {
    for (const cg of eventLegs(e)) {
      const key = cg || UNASSIGNED;
      if (!buckets[key]) buckets[key] = { byType: {}, total: 0 };
      buckets[key].byType[e.type] = (buckets[key].byType[e.type] || 0) + 1;
      buckets[key].total += 1;
      grand += 1;
    }
    typeSet.add(e.type);
  }
  const order = caregivers.map((c) => c.id).filter((id) => buckets[id]);
  if (buckets[UNASSIGNED]) order.push(UNASSIGNED);
  const typeKeys = Object.keys(TYPES).filter((t) => typeSet.has(t));
  return { buckets, order, typeKeys, grand };
}

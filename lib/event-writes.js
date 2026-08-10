import crypto from 'node:crypto';
import db from './db.js';
import { isTrip } from './constants.js';

// Normalize a request body into the exact column set we persist.
function normalize(b) {
  return {
    title: String(b.title).trim(),
    type: b.type,
    child_id: b.child_id,
    caregiver_id: b.caregiver_id || null,
    // Distinct pickup-leg parent, stored ONLY for a two-leg trip (pd='both') when it's set AND
    // differs from the drop-off parent — so "same parent both ways" and an unfilled pickup collapse
    // to NULL, staying byte-identical to a legacy 'both' (1 trip, unchanged seal). Forced NULL for
    // non-trips / single-leg trips, same discipline as pd being coerced to 'dropoff' just below.
    pickup_caregiver_id:
      isTrip(b.type) && b.pd === 'both' && b.pickup_caregiver_id && b.pickup_caregiver_id !== b.caregiver_id
        ? b.pickup_caregiver_id
        : null,
    pd: isTrip(b.type) ? b.pd : 'dropoff',
    date: b.date,
    time: b.time,
    who: (b.who || '').trim(),
    notes: (b.notes || '').trim(),
  };
}
// series_id is NEVER taken from a request body — series membership is server-authoritative
// (the bulk route mints it). normalize() therefore omits it and each call site sets it explicitly.

const insertEvent = db.prepare(
  `INSERT INTO events (id, title, type, child_id, caregiver_id, pickup_caregiver_id, pd, date, time, who, notes, series_id, subscription_id, ical_uid, ical_key)
   VALUES (@id, @title, @type, @child_id, @caregiver_id, @pickup_caregiver_id, @pd, @date, @time, @who, @notes, @series_id, @subscription_id, @ical_uid, @ical_key)`
);
const updateEvent = db.prepare(
  `UPDATE events SET title=@title, type=@type, child_id=@child_id, caregiver_id=@caregiver_id,
     pickup_caregiver_id=@pickup_caregiver_id, pd=@pd, date=@date, time=@time, who=@who, notes=@notes,
     updated_at=datetime('now')
   WHERE id=@id`
);
const getEvent = db.prepare('SELECT * FROM events WHERE id = ?');
const deleteEvent = db.prepare('DELETE FROM events WHERE id = ?');
const insertAudit = db.prepare(
  'INSERT INTO event_audit (event_id, action, snapshot) VALUES (@event_id, @action, @snapshot)'
);

function audit(event_id, action, row) {
  insertAudit.run({ event_id, action, snapshot: JSON.stringify(row) });
}
const newId = () => 'e' + crypto.randomUUID().slice(0, 12);

// create / update snapshot the resulting row; delete snapshots the row as it was.
export const createEvent = db.transaction((b) => {
  const id = newId();
  // series_id / subscription_id / ical_uid / ical_key are all null for a normal single create — only
  // the iCal sync path (createEventsBulk) tags rows with a subscription, source UID and routing key.
  insertEvent.run({
    id,
    ...normalize(b),
    series_id: null,
    subscription_id: null,
    ical_uid: null,
    ical_key: null,
  });
  const row = getEvent.get(id);
  audit(id, 'create', row);
  return row;
});

// Caller must ensure the id exists (the PUT route does a 404 pre-check). Called with a
// missing id, the audit insert hits a NOT NULL on snapshot and the whole tx rolls back.
export const updateEventTx = db.transaction((id, b) => {
  updateEvent.run({ id, ...normalize(b) });
  const row = getEvent.get(id);
  audit(id, 'update', row);
  return row;
});

export const deleteEventTx = db.transaction((id) => {
  const row = getEvent.get(id);
  if (!row) return false;
  audit(id, 'delete', row); // snapshot BEFORE the row leaves the table
  deleteEvent.run(id);
  return true;
});

// series_id (server-minted by the bulk route) links every row of a recurring rule into one series
// so it can later be edited/deleted as a unit; null keeps the rows independent. subscription_id /
// ical_uid / ical_key ride per-item off the body (set only by the iCal sync path), defaulting NULL so
// the manual recurring-add caller is unaffected. ical_key is the per-event routing key (v13) and is
// NULL for a feed pinned to one child.
export const createEventsBulk = db.transaction((items, series_id = null) => {
  let n = 0;
  for (const b of items) {
    const id = newId();
    insertEvent.run({
      id,
      ...normalize(b),
      series_id,
      subscription_id: b.subscription_id || null,
      ical_uid: b.ical_uid || null,
      ical_key: b.ical_key || null,
    });
    audit(id, 'create', getEvent.get(id));
    n++;
  }
  return n;
});

const getSeriesRows = db.prepare('SELECT * FROM events WHERE series_id = ? ORDER BY date, time');
// Update the shared fields across a whole series but keep each occurrence's own date.
const updateSeriesRow = db.prepare(
  `UPDATE events SET title=@title, type=@type, child_id=@child_id, caregiver_id=@caregiver_id,
     pickup_caregiver_id=@pickup_caregiver_id, pd=@pd, time=@time, who=@who, notes=@notes,
     updated_at=datetime('now')
   WHERE id=@id`
);

// Apply one edit to every occurrence in the series (dates stay per-row). Returns the count
// touched (0 = unknown/empty series → caller 404s). Each row gets its own audit 'update'.
export const updateSeriesTx = db.transaction((series_id, fields) => {
  const rows = getSeriesRows.all(series_id);
  if (!rows.length) return 0;
  const shared = normalize(fields);
  for (const r of rows) {
    updateSeriesRow.run({ ...shared, id: r.id });
    audit(r.id, 'update', getEvent.get(r.id));
  }
  return rows.length;
});

// Delete every occurrence in the series, snapshotting each row before it leaves the table.
export const deleteSeriesTx = db.transaction((series_id) => {
  const rows = getSeriesRows.all(series_id);
  for (const r of rows) {
    audit(r.id, 'delete', r);
    deleteEvent.run(r.id);
  }
  return rows.length;
});

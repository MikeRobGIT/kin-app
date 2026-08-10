import crypto from 'node:crypto';
import db from './db.js';
import { takesLeg } from './constants.js';

// Saved iCal feed subscriptions (calendar_subscriptions, v12; per-event child routing v13). Config
// rows with a stable id (imported events tag themselves with subscription_id). Like
// lib/family-writes.js these are plain config writes with no audit table. The actual event inserts a
// sync produces go through the transactional, audited lib/event-writes.js helpers — this module only
// owns the subscription row, including its child_map routing rules.

const newId = () => 'sub' + crypto.randomUUID().slice(0, 12);

const insert = db.prepare(
  `INSERT INTO calendar_subscriptions (id, label, url, child_id, type, caregiver_id, pd)
   VALUES (@id, @label, @url, @child_id, @type, @caregiver_id, @pd)`
);
const getById = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?');
const listStmt = db.prepare('SELECT * FROM calendar_subscriptions ORDER BY created_at DESC, id DESC');
const del = db.prepare('DELETE FROM calendar_subscriptions WHERE id = ?');
const untag = db.prepare('UPDATE events SET subscription_id = NULL WHERE subscription_id = ?');
const markStmt = db.prepare(
  "UPDATE calendar_subscriptions SET last_synced_at = datetime('now'), last_status = @status WHERE id = @id"
);
const updateStmt = db.prepare(
  `UPDATE calendar_subscriptions
      SET label = @label, type = @type, pd = @pd, child_id = @child_id, child_map = @child_map
    WHERE id = @id`
);
const mapStmt = db.prepare('UPDATE calendar_subscriptions SET child_map = ? WHERE id = ?');

export function createSubscription(b) {
  const id = newId();
  insert.run({
    id,
    label: (b.label || '').trim(),
    url: String(b.url).trim(),
    // NULL = no pinned child: the feed carries more than one kid and each event is routed by the
    // name in its title (v13). Coerced here so an absent field can't throw "Missing named parameter".
    child_id: b.child_id || null,
    type: b.type,
    caregiver_id: b.caregiver_id || null,
    // pd is only meaningful for a type that carries a leg — a real trip type, or the '' sentinel
    // (every from-title outcome is trip-typed). Store 'dropoff' by default there, NULL otherwise.
    pd: takesLeg(b.type) ? b.pd || 'dropoff' : null,
  });
  return getById.get(id);
}

export const getSubscription = (id) => getById.get(id);
export const listSubscriptions = () => listStmt.all();

// Delete the subscription and clear the tag on its imported events (they remain as plain events,
// never deleted — a re-sync of a re-added subscription simply re-imports what the feed still lists).
export const deleteSubscription = db.transaction((id) => {
  untag.run(id);
  return del.run(id).changes;
});

// Record the outcome of a "Sync now" run (last_synced_at + a human-readable status/error).
export function markSubscriptionSynced(id, status) {
  return markStmt.run({ id, status: status || 'ok' }).changes;
}

// Patch a subscription's editable fields: label, activity type ('' = from title), leg, the pinned
// child (NULL = route by title) and the saved name→child assignments. url and caregiver_id stay
// create-time. The caller passes a MERGED row — an absent field must already have been filled from
// the stored row — so this is a plain write with no merge logic of its own.
export function updateSubscription(id, { label, type, pd, child_id, child_map }) {
  updateStmt.run({
    id,
    label: (label || '').trim(),
    type,
    pd: pd || null,
    child_id: child_id || null,
    child_map: JSON.stringify(child_map || {}),
  });
  return getById.get(id);
}

// Sync-time only: remember the keys a pull found but couldn't route, without touching child_id.
export const setChildMap = (id, map) => mapStmt.run(JSON.stringify(map || {}), id).changes;

// ---- import dedup ----------------------------------------------------------
// Lives here rather than in the sync route so it can be tested without HTTP — it is the logic that
// decides whether an occurrence is silently dropped or duplicated, and both failures are invisible.
//
// Dedup has to survive a feed being switched between pinned and per-event routing, because the two
// modes write different ical_key shapes and an exact-key lookup would miss every existing row and
// re-import the whole feed as duplicates.
const dedupPinnedStmt = db.prepare(
  'SELECT 1 FROM events WHERE subscription_id = ? AND ical_uid = ? AND date = ?'
);
const dedupRoutedStmt = db.prepare(
  `SELECT 1 FROM events
   WHERE subscription_id = ? AND ical_uid = ? AND date = ? AND (ical_key IS ? OR ical_key IS NULL)`
);
const dedupLegacyStmt = db.prepare(
  `SELECT 1 FROM events
   WHERE subscription_id = ? AND ical_uid = ? AND date = ? AND ical_key IS NULL`
);

// True when this occurrence is already imported for this subscription.
//   pinned    — ignore ical_key entirely. uid+date is unique per subscription when one child owns
//               every event, which is also what a per-event → pinned switch needs.
//   per-event — match the exact routing key OR a legacy NULL key left by a pinned import. The
//               non-null half keeps two kids sharing one uid+date apart; the NULL half covers the
//               pinned → per-event switch.
export function isImported(subscription_id, uid, date, { perEvent = false, key = null } = {}) {
  const stmt = perEvent ? dedupRoutedStmt : dedupPinnedStmt;
  const row = perEvent
    ? stmt.get(subscription_id, uid, date, key)
    : stmt.get(subscription_id, uid, date);
  return !!row;
}

// True when this occurrence's slot is already filled by a PINNED import (ical_key NULL). Used to keep
// the "needs a child" count honest right after a pinned → per-event switch: those occurrences are
// already on the calendar, so they are skipped rather than reported as waiting. Deliberately the
// strict NULL-key lookup, not isImported's looser pinned form — on a feed that was always per-event,
// kid A's keyed row must not mask kid B's genuinely unrouted event.
export const isImportedUnkeyed = (subscription_id, uid, date) =>
  !!dedupLegacyStmt.get(subscription_id, uid, date);

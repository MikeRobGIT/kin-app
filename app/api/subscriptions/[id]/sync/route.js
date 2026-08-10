export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { TYPES } from '@/lib/constants';
import { validateEvent, RULE_LIMITS } from '@/lib/validate';
import { createEventsBulk } from '@/lib/event-writes';
import {
  getSubscription,
  markSubscriptionSynced,
  setChildMap,
  isImported,
  isImportedUnkeyed,
} from '@/lib/subscription-writes';
import { parseIcs } from '@/lib/ical';
import { parseChildMap, routeTitle, feedType } from '@/lib/ical-map';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — a season's schedule is a few KB; cap abuse/mistakes
const MAX_ADD = 500; // ceiling on new events written per sync (a big multi-year feed is truncated)

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// A generous window bounds open-ended RRULEs: 60 days back (recent games stay importable) to a year
// ahead. A re-sync later slides the window forward and picks up the next stretch. Built by integer
// day offset off local Y/M/D so a DST midnight can't drop a day (kin.md date rule).
function window() {
  const n = new Date();
  const from = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 60);
  const to = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 365);
  return { from: ymd(from), to: ymd(to) };
}

const rosterStmt = db.prepare('SELECT id, name FROM children WHERE archived = 0 ORDER BY sort');

// Sync now: fetch the feed, expand it, and ADD occurrences not already imported for this
// subscription (dedup on uid+date+routing key). Add-only by design — never updates or deletes
// already-imported events, so a manual edit to an imported game is never clobbered.
// A subscription with NO pinned child routes each occurrence to a child by the name in its title
// (lib/ical-map.js); a title it can't resolve is HELD, never filed onto a fallback child, and its key
// is remembered in child_map for the user to assign in Settings.
// Returns { added, skipped, pending, total }.
export async function POST(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  const sub = getSubscription(id);
  if (!sub) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // webcal:// is https over the wire. ponytail: single-user self-hosted — the only actor is the
  // admin fetching their own kid's calendar — so scheme validation only, no SSRF private-range
  // blocking (which would also break a legitimate LAN calendar server).
  const url = String(sub.url).replace(/^webcal:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'Invalid calendar URL' }, { status: 400 });
  }

  let text;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error('Feed too large');
    text = new TextDecoder('utf-8').decode(buf);
  } catch {
    const msg = 'Could not fetch calendar';
    markSubscriptionSynced(id, msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const { from, to } = window();
  let occ;
  try {
    occ = parseIcs(text, { from, to });
  } catch {
    const msg = 'Could not parse calendar';
    markSubscriptionSynced(id, msg);
    return NextResponse.json({ error: msg }, { status: 422 });
  }

  const typeLabel = TYPES[sub.type]?.label || 'Event';
  const perEvent = !sub.child_id; // no pinned child → route by the name in each title
  const roster = perEvent ? rosterStmt.all() : [];
  const rules = perEvent ? parseChildMap(sub.child_map) : {};
  const seen = new Set(); // guard against the same occurrence appearing twice within one feed
  const rows = [];
  let skipped = 0;
  let pending = 0;
  let dirty = false;

  for (const o of occ) {
    let title = o.title || typeLabel; // SUMMARY may be absent; a title is required
    let child_id = sub.child_id;
    let type = feedType(sub.type, o.title);
    let ical_key = null;

    if (perEvent) {
      // `guess: !!o.title` — with no SUMMARY the title above is synthesized from the FEED's own type
      // label, and guessing off that round-trips wrong: a `schoolevent` feed yields "School event",
      // whose `school` hint is a different, TRIP-typed key, so a title-less occurrence would silently
      // gain a transport leg. The fallback must stay BEFORE routing though — an empty title
      // normalizes to an empty key, which the record-the-key guard below skips, which would strand
      // the occurrence as permanently held with no review row to click.
      const r = routeTitle(title, roster, rules, sub.type, { guess: !!o.title });
      if (!r.child_id) {
        // Held for review — NEVER filed onto a fallback child. Remember the key so Settings can list
        // it; the event imports on the next sync once the user assigns it. Bounded by the same cap
        // the API validator enforces: setChildMap writes straight to the column, so a feed pointed at
        // the wrong URL must not be able to grow the map without limit.
        // Record the original-case segment alongside the (normalized) key so the review UI can label
        // the group "Minnows (3yr-5yr)" rather than "minnows 3yr 5yr". hasOwn, not `in`: a segment
        // normalizing to an Object.prototype name ("constructor") would otherwise read as already
        // present and never be recorded, stranding its events with no way to assign them.
        if (r.key && !Object.hasOwn(rules, r.key) && Object.keys(rules).length < RULE_LIMITS.keys) {
          rules[r.key] = { c: '', s: r.seg };
          dirty = true;
        }
        // Count each held occurrence once, and don't report one as waiting when it is already on the
        // calendar from a pinned import (the key is still recorded above — future occurrences of the
        // group need the rule).
        const heldKey = `${o.uid}\x00${o.date}\x00held`;
        if (seen.has(heldKey)) { skipped++; continue; }
        seen.add(heldKey);
        if (o.uid && isImportedUnkeyed(id, o.uid, o.date)) skipped++;
        else pending++;
        continue;
      }
      child_id = r.child_id;
      title = r.title; // the child's name segment stripped off
      type = r.type; // the group's explicit type, else a keyword guess, else the feed's own
      ical_key = r.key;
    }

    // Dedup AFTER routing so the routing key participates: a feed whose UID identifies the CLASS
    // rather than the registration emits one VEVENT per kid with the same uid+date, and keying on
    // uid+date alone would silently drop the second kid's event as "already imported".
    const seenKey = `${o.uid}\x00${o.date}\x00${ical_key ?? ''}`;
    if (seen.has(seenKey)) { skipped++; continue; }
    seen.add(seenKey);
    if (o.uid && isImported(id, o.uid, o.date, { perEvent, key: ical_key })) { skipped++; continue; }

    rows.push({
      title,
      type,
      child_id,
      caregiver_id: sub.caregiver_id || '',
      pd: sub.pd || 'dropoff',
      date: o.date,
      time: o.time,
      who: '',
      notes: o.notes || '',
      subscription_id: id,
      ical_uid: o.uid,
      ical_key,
    });
    if (rows.length >= MAX_ADD) break;
  }

  // Persist newly-discovered keys BEFORE the validation gate below, so a single bad row can't lose
  // the review list this pull just built.
  if (dirty) setChildMap(id, rules);

  // Validate every mapped row (active-gated) before the bulk write — same guard as logEventsBulk.
  // On the per-event path routeTitle already guarantees an ACTIVE child and a non-empty title, so
  // this only really fires for a pinned feed whose child/parent was archived after it was created.
  for (const r of rows) {
    const err = validateEvent(r, db, { requireActive: true });
    if (err) {
      const msg = `${err} — update the subscription's child/parent`;
      markSubscriptionSynced(id, msg);
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  }

  const added = rows.length ? createEventsBulk(rows) : 0;
  // Reuse last_status as the needs-attention signal: the Settings table already renders any status
  // other than 'ok', so held events stay visible on the feed row across syncs the user didn't watch.
  markSubscriptionSynced(
    id,
    pending ? `${pending} event${pending === 1 ? '' : 's'} need a child` : 'ok'
  );
  return NextResponse.json({ added, skipped, pending, total: occ.length });
}

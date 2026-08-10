export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateSubscriptionPatch } from '@/lib/validate';
import { getSubscription, deleteSubscription, updateSubscription } from '@/lib/subscription-writes';
import { parseChildMap } from '@/lib/ical-map';
import { takesLeg } from '@/lib/constants';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// Update a subscription's routing: the pinned child (null = route each event by the name in its
// title) and the saved name→child assignments. A whole-map PUT — the client already holds the map
// from GET, so one handler serves both "assign a pending key" and "correct an earlier assignment".
// url/parent stay create-time; label, type and leg are editable. 404 pre-check before the write, like
// DELETE below.
// ponytail: last-write-wins against a concurrent sync appending a newly-seen key; single-user, and
// the next sync rediscovers anything lost.
export async function PUT(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  const sub = getSubscription(id);
  if (!sub) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let b;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // An absent field means "unchanged"; an explicit null/'' child_id switches to per-event routing.
  // Merged HERE so the validator can check invariants that span fields — pd's coherence with the
  // resulting type in particular.
  const type = b.type === undefined ? sub.type : b.type;
  const patch = {
    label: b.label === undefined ? sub.label : String(b.label ?? '').trim(),
    type,
    // Recomputed from the MERGED type: switching a feed to a caregiving type must drop the leg, or
    // normalize() and lib/report.js disagree about whether its events are transport.
    pd: takesLeg(type) ? (b.pd === undefined ? sub.pd || 'dropoff' : b.pd || 'dropoff') : null,
    child_id: b.child_id === undefined ? sub.child_id : b.child_id || null,
    child_map: b.child_map === undefined ? parseChildMap(sub.child_map) : b.child_map,
  };
  const err = validateSubscriptionPatch(patch, db);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  return NextResponse.json(updateSubscription(id, patch));
}

// Remove a subscription. Its imported events are kept (tag cleared) — never deleted. 404 pre-check
// so a missing id is a clean 404 rather than a silent no-op.
export async function DELETE(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  if (!getSubscription(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  deleteSubscription(id);
  return NextResponse.json({ ok: true });
}

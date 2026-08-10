export const dynamic = 'force-dynamic';
import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateEvent } from '@/lib/validate';
import { createEventsBulk } from '@/lib/event-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

const MAX_BULK = 366; // mirrors the parse-route expansion cap

export async function POST(request) {
  const g = await guard();
  if (g) return g;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const rows = body?.events;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'No entries to create' }, { status: 400 });
  }
  if (rows.length > MAX_BULK) {
    return NextResponse.json({ error: `Too many entries (max ${MAX_BULK})` }, { status: 400 });
  }

  // Validate everything first — all-or-nothing, so a bad row never half-writes the batch.
  // Bulk is a CREATE path → require active members (no archived child/parent on new events).
  for (let i = 0; i < rows.length; i++) {
    const err = validateEvent(rows[i], db, { requireActive: true });
    if (err) return NextResponse.json({ error: err, index: i }, { status: 400 });
  }

  // A recurring rule links its occurrences into one series (server-generated id) so they can be
  // edited/deleted as a unit; without the flag rows stay independent.
  const series_id = body?.series === true ? 's' + crypto.randomUUID().slice(0, 12) : null;
  const created = createEventsBulk(rows, series_id);
  return NextResponse.json({ created, series_id }, { status: 201 });
}

export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed, authSecret } from '@/lib/auth';
import { isMonth } from '@/lib/validate';
import { sealMonth } from '@/lib/seal';
import { insertSeal, listSeals } from '@/lib/seal-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// Everything needed to (re)compute a month's canonical record. date is zero-padded
// YYYY-MM-DD, so a lexicographic BETWEEN month-01 .. month-31 selects exactly the month.
function monthData(month) {
  const events = db
    .prepare('SELECT * FROM events WHERE date >= ? AND date <= ? ORDER BY date, time')
    .all(`${month}-01`, `${month}-31`);
  const schedules = db.prepare('SELECT * FROM schedules').all();
  const overrides = db.prepare('SELECT * FROM schedule_overrides').all();
  return { events, schedules, overrides };
}

export async function GET() {
  const g = await guard();
  if (g) return g;
  return NextResponse.json({ seals: listSeals() });
}

export async function POST(request) {
  const g = await guard();
  if (g) return g;

  let b;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!isMonth(b?.month)) return NextResponse.json({ error: 'Invalid month' }, { status: 400 });

  // A seal keyed by a missing/short AUTH_SECRET would be effectively unkeyed — fail loudly
  // rather than persist a worthless digest. (isAuthed() already requires it, but be explicit.)
  let secret;
  try {
    secret = authSecret();
  } catch {
    return NextResponse.json({ error: 'AUTH_SECRET is not configured' }, { status: 500 });
  }

  const { events, schedules, overrides } = monthData(b.month);
  const { sha256, hmac, event_count } = sealMonth(b.month, events, schedules, overrides, secret);
  const row = insertSeal({ month: b.month, sha256, hmac, event_count });
  return NextResponse.json(row, { status: 201 });
}

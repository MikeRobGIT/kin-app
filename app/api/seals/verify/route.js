export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed, authSecret } from '@/lib/auth';
import { isMonth } from '@/lib/validate';
import { verifySeal } from '@/lib/seal';
import { getLatestSeal } from '@/lib/seal-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// Recompute the latest seal for ?month=YYYY-MM over the CURRENT data and report match/tamper.
export async function GET(request) {
  const g = await guard();
  if (g) return g;

  const month = new URL(request.url).searchParams.get('month');
  if (!isMonth(month)) return NextResponse.json({ error: 'Invalid month' }, { status: 400 });

  const seal = getLatestSeal(month);
  if (!seal) return NextResponse.json({ month, sealed: false });

  let secret;
  try {
    secret = authSecret();
  } catch {
    return NextResponse.json({ error: 'AUTH_SECRET is not configured' }, { status: 500 });
  }

  const events = db
    .prepare('SELECT * FROM events WHERE date >= ? AND date <= ?')
    .all(`${month}-01`, `${month}-31`);
  const schedules = db.prepare('SELECT * FROM schedules').all();
  const overrides = db.prepare('SELECT * FROM schedule_overrides').all();

  const result = verifySeal(seal, events, schedules, overrides, secret);
  return NextResponse.json({
    month,
    sealed: true,
    sealed_at: seal.sealed_at,
    match: result.match,
    event_count_sealed: seal.event_count,
    event_count_now: result.event_count,
  });
}

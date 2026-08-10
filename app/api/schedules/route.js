export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateSchedule } from '@/lib/validate';
import { createSchedule } from '@/lib/schedule-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET() {
  const g = await guard();
  if (g) return g;
  const schedules = db.prepare('SELECT * FROM schedules ORDER BY created_at').all();
  const overrides = db.prepare('SELECT * FROM schedule_overrides ORDER BY date_from').all();
  return NextResponse.json({ schedules, overrides });
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
  const err = validateSchedule(b, db);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const row = createSchedule(b);
  return NextResponse.json(row, { status: 201 });
}

export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateEvent, isRealDate } from '@/lib/validate';
import { createEvent } from '@/lib/event-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(request) {
  const g = await guard();
  if (g) return g;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  let rows;
  if (from || to) {
    if (!isRealDate(from) || !isRealDate(to)) {
      return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
    }
    rows = db
      .prepare('SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date, time')
      .all(from, to);
  } else {
    rows = db.prepare('SELECT * FROM events ORDER BY date, time').all();
  }
  const children = db.prepare('SELECT * FROM children ORDER BY sort').all();
  const caregivers = db.prepare('SELECT * FROM caregivers ORDER BY sort').all();
  return NextResponse.json({ events: rows, children, caregivers });
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
  // Create requires ACTIVE members — a new event can't be assigned to an archived child/parent.
  const err = validateEvent(b, db, { requireActive: true });
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const row = createEvent(b);
  return NextResponse.json(row, { status: 201 });
}

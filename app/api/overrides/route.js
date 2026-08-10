export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateOverride } from '@/lib/validate';
import { createOverride } from '@/lib/schedule-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// List comes from GET /api/schedules ({schedules, overrides}); this route only creates.
export async function POST(request) {
  const g = await guard();
  if (g) return g;

  let b;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const err = validateOverride(b, db);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const row = createOverride(b);
  return NextResponse.json(row, { status: 201 });
}

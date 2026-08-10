export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateFamilyCreate } from '@/lib/validate';
import { createCaregiver } from '@/lib/family-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// The full roster (active + archived) for the Settings Family manager.
export async function GET() {
  const g = await guard();
  if (g) return g;
  return NextResponse.json({ caregivers: db.prepare('SELECT * FROM caregivers ORDER BY sort').all() });
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
  const err = validateFamilyCreate(b, db, 'caregivers');
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  return NextResponse.json(createCaregiver(b), { status: 201 });
}

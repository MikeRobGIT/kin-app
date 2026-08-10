export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateFamilyUpdate } from '@/lib/validate';
import { updateCaregiver, activeCount } from '@/lib/family-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// Rename / recolor / archive-toggle a parent. IDs stay stable so schedules/events that
// reference them never break; never deletes.
export async function PUT(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  const existing = db.prepare('SELECT id, name, archived FROM caregivers WHERE id = ?').get(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let b;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const err = validateFamilyUpdate(b, db, 'caregivers', existing);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  // Refuse to archive the last active parent — parent-time + involvement need at least one.
  const archiving = (b.archived === 1 || b.archived === true) && !existing.archived;
  if (archiving && activeCount('caregivers') <= 1) {
    return NextResponse.json({ error: 'Cannot archive the last active parent' }, { status: 409 });
  }

  return NextResponse.json(updateCaregiver(id, b));
}

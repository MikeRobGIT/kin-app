export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateOverride } from '@/lib/validate';
import { updateOverrideTx, deleteOverrideTx } from '@/lib/schedule-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function PUT(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  const existing = db.prepare('SELECT id FROM schedule_overrides WHERE id = ?').get(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let b;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const err = validateOverride(b, db);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const row = updateOverrideTx(id, b);
  return NextResponse.json(row);
}

export async function DELETE(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  const ok = deleteOverrideTx(id);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

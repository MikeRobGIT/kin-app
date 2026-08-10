export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateEvent } from '@/lib/validate';
import { updateSeriesTx, deleteSeriesTx } from '@/lib/event-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// Edit every occurrence in a recurring series at once. The body is a full event (the edited
// occurrence); its shared fields are applied to all rows while each keeps its own date.
export async function PUT(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  let b;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const err = validateEvent(b, db);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const n = updateSeriesTx(id, b);
  if (!n) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ updated: n });
}

// Delete every occurrence in a series (each snapshotted to the audit log first).
export async function DELETE(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  const n = deleteSeriesTx(id);
  if (!n) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ deleted: n });
}

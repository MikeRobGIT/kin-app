export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateEvent, isRealDate } from '@/lib/validate';
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

// Delete every occurrence in a series (each snapshotted to the audit log first). `?from=YYYY-MM-DD`
// narrows it to that date onward — the modal's "this and following" scope.
export async function DELETE(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  const from = new URL(request.url).searchParams.get('from');
  // Same shape as the GET /api/events range check. Validate BEFORE the tx so a bad date deletes nothing.
  if (from !== null && !isRealDate(from)) {
    return NextResponse.json({ error: 'Invalid date' }, { status: 400 });
  }
  const n = deleteSeriesTx(id, from);
  // deleteSeriesTx returns 0 for two different things: an unknown series, and a known series with
  // nothing at or after `from`. Only the first is a 404 — a bounded delete that matched no rows is
  // a successful no-op, and reporting "Not found" for a series that plainly exists misleads a
  // client whose counts went stale (a concurrent delete, or the 5-minute poll).
  if (!n && from === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ deleted: n });
}

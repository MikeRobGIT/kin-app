export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { revokeShareToken } from '@/lib/share-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// Revoke (kill) a share link. Idempotent-ish: 404 only if the id never existed.
export async function DELETE(request, { params }) {
  const g = await guard();
  if (g) return g;

  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  const changed = revokeShareToken(n);
  if (!changed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

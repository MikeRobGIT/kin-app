export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';

// Unauthenticated, but only ever runs SELECT 1 — no data is exposed. Lets Docker
// and Coolify detect a corrupt or unwritable DB instead of a green static page.
export async function GET() {
  try {
    db.prepare('SELECT 1').get();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 503 });
  }
}

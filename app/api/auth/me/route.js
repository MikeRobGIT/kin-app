export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { isAuthed, renewIfStale } from '@/lib/auth';

export async function GET() {
  // Intentional GET side effect: sliding session renewal for always-on kiosks.
  // Idempotent — only re-mints when the token is older than the renewal window.
  await renewIfStale();
  return NextResponse.json({ authed: await isAuthed() });
}

export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { validateSubscription } from '@/lib/validate';
import { createSubscription, listSubscriptions } from '@/lib/subscription-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET() {
  const g = await guard();
  if (g) return g;
  return NextResponse.json({ subscriptions: listSubscriptions() });
}

// Create a saved subscription. Does NOT sync — the client calls POST .../[id]/sync right after
// (so the first pull's result can be reported and a slow/bad feed doesn't hold up the create).
export async function POST(request) {
  const g = await guard();
  if (g) return g;

  let b;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const err = validateSubscription(b, db, { requireActive: true });
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  return NextResponse.json(createSubscription(b), { status: 201 });
}

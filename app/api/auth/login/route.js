export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { checkPassword, createSession } from '@/lib/auth';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { password } = body || {};
  if (!password || !checkPassword(password)) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }
  await createSession();
  return NextResponse.json({ ok: true });
}
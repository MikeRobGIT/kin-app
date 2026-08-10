export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { isAuthed, authSecret } from '@/lib/auth';
import { validateMcpTokenInput } from '@/lib/validate';
import { createMcpToken, listMcpTokens } from '@/lib/mcp-token-writes';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET() {
  const g = await guard();
  if (g) return g;
  return NextResponse.json({ tokens: listMcpTokens() });
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
  const err = validateMcpTokenInput(b);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  let secret;
  try {
    secret = authSecret();
  } catch {
    return NextResponse.json({ error: 'AUTH_SECRET is not configured' }, { status: 500 });
  }

  const { token, row } = createMcpToken({ label: b.label }, secret);
  // The raw token is returned exactly once — it is not stored and cannot be recovered later.
  // The client builds the capability URL from its OWN origin (window.location.origin); the server
  // must NOT — behind the proxy `request.url` is the container's internal bind (0.0.0.0:3000).
  return NextResponse.json({ token, row }, { status: 201 });
}

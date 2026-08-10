export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { makeKinHandler, noStore } from '@/lib/mcp-server';
import { mcpConfigured, verifyKinToken, assertMcpAuthReady } from '@/lib/mcp-auth';

// The [token] path segment IS the credential (same model as /share/<token>). Verified
// constant-time; a match runs the handler with basePath scoped to this token's URL. The
// response is marked no-store so an intermediary proxy can't cache it past token revocation.

// Reuse the handler per basePath instead of rebuilding it (with a full tool registration) on
// every request — only a valid token reaches here, so this Map holds one entry per active
// token (env or minted), a handful at most for a single-user install.
const handlersByBasePath = new Map();
function handlerFor(basePath) {
  let h = handlersByBasePath.get(basePath);
  if (!h) { h = makeKinHandler(basePath); handlersByBasePath.set(basePath, h); }
  return h;
}

// Order: 503 (nothing configured) → 500 (minted tokens exist but AUTH_SECRET missing —
// fail loud, never a masquerading 401) → 401 (bad token).
async function handler(req, { params }) {
  const { token } = await params;
  if (!mcpConfigured()) return NextResponse.json({ error: 'MCP is not configured.' }, { status: 503 });
  try {
    assertMcpAuthReady();
  } catch {
    return NextResponse.json({ error: 'AUTH_SECRET is not configured' }, { status: 500 });
  }
  if (!verifyKinToken(token)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return noStore(await handlerFor(`/api/link/${token}`)(req));
}

export { handler as GET, handler as POST, handler as DELETE };

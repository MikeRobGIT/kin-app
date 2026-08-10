export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { withMcpAuth } from 'mcp-handler';
import { makeKinHandler, noStore } from '@/lib/mcp-server';
import { mcpConfigured, verifyKinToken, assertMcpAuthReady } from '@/lib/mcp-auth';

// withMcpAuth extracts the bearer token; we constant-time compare it. Returning undefined → 401.
const verifyToken = async (_req, bearerToken) =>
  verifyKinToken(bearerToken) ? { token: bearerToken, scopes: [], clientId: 'kin-owner' } : undefined;

// Built on first request rather than at module load — the same laziness app/api/link/[token]/[transport]
// already uses, and for a concrete reason: makeKinHandler registers the full tool set and leaves an
// open handle nothing here closes, so constructing it at import time makes merely IMPORTING this
// module hang a plain `node --test` process forever (Node 20, no --test-force-exit). That kept this
// route out of the app-wide auth-contract test — exactly the coverage gap route tests exist to close.
// Cached after the first build, so registration is still paid once, not per request.
let authed;
function authedHandler() {
  if (!authed) authed = withMcpAuth(makeKinHandler('/api'), verifyToken, { required: true });
  return authed;
}

// Unconfigured server → 503 before any auth, so a fresh install is closed, not open.
// Minted tokens with a missing AUTH_SECRET → 500 (fail loud, never a masquerading 401).
async function handler(req) {
  if (!mcpConfigured()) return NextResponse.json({ error: 'MCP is not configured.' }, { status: 503 });
  try {
    assertMcpAuthReady();
  } catch {
    return NextResponse.json({ error: 'AUTH_SECRET is not configured' }, { status: 500 });
  }
  return noStore(await authedHandler()(req));
}

export { handler as GET, handler as POST, handler as DELETE };

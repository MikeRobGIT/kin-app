import { NextResponse } from 'next/server';

const COOKIE = 'tt_session';

// Next 16 renamed `middleware` -> `proxy` (runs on the nodejs runtime).
// Lightweight gate: presence check only. API routes do full HMAC verification.
export function proxy(request) {
  const { pathname } = request.nextUrl;

  // /login is always reachable. We intentionally do NOT bounce a present cookie
  // back to '/', because a present-but-invalid cookie (e.g. an expired session,
  // which the API now rejects) would otherwise ping-pong with the auth redirect.
  if (pathname === '/login') return NextResponse.next();

  // /share/<token> is intentionally login-less: the capability token IS the credential,
  // validated server-side by the page (HMAC lookup + server-enforced expiry/revoke). The
  // proxy only waves it past the cookie gate; it grants no access on its own. Match a single
  // token segment only (so a future authed page under /share/ isn't accidentally un-gated),
  // and mark the response no-store so an intermediary proxy can't cache a report past revocation.
  if (pathname.startsWith('/share/') && pathname.split('/').length === 3) {
    const res = NextResponse.next();
    res.headers.set('Cache-Control', 'private, no-store, max-age=0');
    return res;
  }

  // Presence-only gate for pages — a convenience, not the security boundary.
  // Real HMAC verification happens in every API route and in the page's own
  // isAuthed() guard (defense-in-depth against middleware bypass, CVE-2025-29927).
  if (!request.cookies.get(COOKIE)) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Protect everything except login, the auth API, and Next internals/assets
  // (incl. the App Router icons /icon.svg + /apple-icon.png and the PWA manifest
  // /manifest.webmanifest — all public, fetched without a session on the login
  // screen / during home-screen install, so keep them out of the gate).
  // Filename exclusions are escaped + anchored so ONLY the exact paths bypass the
  // gate (/icon.svg.hack must still 307) — api|_next stay prefixes on purpose.
  matcher: ['/((?!api|_next/static|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|manifest\\.webmanifest$).*)'],
};

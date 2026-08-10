import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { authSecret } from './secret.js';

const COOKIE = 'tt_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// The AUTH_SECRET policy lives in lib/secret.js (Next-free, so server libs and node:test can
// import it without pulling in next/headers). Re-exported here so routes keep importing it
// from '@/lib/auth' — crypto features (e.g. monthly seals) key on it and must fail loudly on
// a misconfigured instance instead of minting an unkeyed digest.
export { authSecret };
const secret = authSecret;

function appPassword() {
  const p = process.env.APP_PASSWORD;
  if (!p) throw new Error('APP_PASSWORD is not set.');
  return p;
}

// Sign a value with HMAC so the cookie cannot be forged.
function sign(value) {
  const h = crypto.createHmac('sha256', secret()).update(value).digest('hex');
  return `${value}.${h}`;
}

function verify(signed) {
  if (!signed || !signed.includes('.')) return null;
  const idx = signed.lastIndexOf('.');
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = crypto
    .createHmac('sha256', secret())
    .update(value)
    .digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Enforce expiry server-side using the embedded timestamp. Without this the
  // 30-day MAX_AGE is only browser-enforced, so a valid-MAC cookie would live
  // forever.
  const m = /^ok:(\d+)$/.exec(value);
  if (!m) return null;
  if (Date.now() - Number(m[1]) > MAX_AGE * 1000) return null;
  return value;
}

// Constant-time password check. Both sides are hashed to fixed-length HMAC
// digests so the comparison never branches on input length.
export function checkPassword(input) {
  const hash = (s) =>
    crypto.createHmac('sha256', secret()).update(String(s)).digest();
  return crypto.timingSafeEqual(hash(input), hash(appPassword()));
}

export async function createSession() {
  const payload = `ok:${Date.now()}`;
  (await cookies()).set(COOKIE, sign(payload), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export async function destroySession() {
  (await cookies()).set(COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

export async function isAuthed() {
  const c = (await cookies()).get(COOKIE);
  if (!c) return false;
  return verify(c.value) !== null;
}

// Sliding renewal for always-on displays: re-mint the session when its embedded
// timestamp is older than RENEW_AFTER. A kiosk that polls /api/auth/me stays
// logged in indefinitely (and the cookie never nears Chrome's 400-day cap);
// a device that goes dark for >MAX_AGE still expires as before.
const RENEW_AFTER = 60 * 60 * 24 * 7; // 7 days

export async function renewIfStale() {
  const c = (await cookies()).get(COOKIE);
  if (!c) return;
  const value = verify(c.value);
  if (!value) return; // invalid/expired: never resurrect, normal 401 path applies
  const ts = Number(/^ok:(\d+)$/.exec(value)[1]);
  if (Date.now() - ts > RENEW_AFTER * 1000) await createSession();
}

import crypto from 'node:crypto';

// Lawyer share-link tokens. Pure: no DB, no env (the caller supplies the secret).
//
// A token is a high-entropy random secret that appears ONCE in the URL. We never store the raw
// token — only hashToken(token) = HMAC-SHA256(AUTH_SECRET, token) — so a DB leak yields no usable
// link, and verifying an incoming token requires the secret too. Expiry + revocation live on the
// stored row (lib/share-writes.js); this module is just the sign/verify primitive.

export function newToken() {
  return crypto.randomBytes(32).toString('hex'); // 256-bit capability secret
}

export function hashToken(token, secret) {
  return crypto.createHmac('sha256', String(secret ?? '')).update(String(token)).digest('hex');
}

import db from './db.js';
import { newToken, hashToken } from './share.js';

const insert = db.prepare(
  `INSERT INTO share_tokens (token_hash, label, date_from, date_to, expires_at)
   VALUES (@token_hash, @label, @date_from, @date_to, datetime('now', @modifier))`
);
const getById = db.prepare('SELECT * FROM share_tokens WHERE id = ?');

// Create a token. Returns { token, row } — `token` (the raw secret) is returned ONCE for the URL
// and never persisted; only its HMAC is stored. `days` must already be validated (7|30|90).
export const createShareToken = db.transaction(({ label, date_from, date_to, days }, secret) => {
  const token = newToken();
  const info = insert.run({
    token_hash: hashToken(token, secret),
    label: (label || '').trim(),
    date_from,
    date_to,
    modifier: `+${days} days`,
  });
  return { token, row: getById.get(info.lastInsertRowid) };
});

// Resolve a raw token to its row IFF it is unrevoked and unexpired — expiry enforced in SQL
// (server clock, UTC). Returns the row or undefined.
export function resolveShareToken(token, secret) {
  return db
    .prepare(
      `SELECT * FROM share_tokens
       WHERE token_hash = ? AND revoked = 0 AND expires_at > datetime('now')`
    )
    .get(hashToken(token, secret));
}

// Management list for the owner UI — never includes a usable token (raw tokens aren't stored).
export function listShareTokens() {
  return db
    .prepare(
      `SELECT id, label, date_from, date_to, expires_at, revoked, created_at,
              (revoked = 0 AND expires_at > datetime('now')) AS active
       FROM share_tokens ORDER BY id DESC`
    )
    .all();
}

export function revokeShareToken(id) {
  return db.prepare('UPDATE share_tokens SET revoked = 1 WHERE id = ?').run(id).changes;
}

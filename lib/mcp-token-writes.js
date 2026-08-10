import db from './db.js';
import { newToken, hashToken } from './share.js';

// In-app MCP agent tokens (mcp_tokens, v9). Same capability-token discipline as
// lib/share-writes.js: the raw token is returned ONCE at mint and never persisted — only its
// HMAC — and revocation is enforced in the lookup SQL. Unlike share links there is no expiry:
// these are long-lived personal agent credentials; revoke is the kill switch, and last_used_at
// gives the owner visibility. The env KIN_MCP_TOKEN remains a parallel fallback credential
// (lib/mcp-auth.js composes both).

const insert = db.prepare(
  'INSERT INTO mcp_tokens (token_hash, label) VALUES (@token_hash, @label)'
);
const getById = db.prepare('SELECT * FROM mcp_tokens WHERE id = ?');
const getActiveByHash = db.prepare(
  'SELECT * FROM mcp_tokens WHERE token_hash = ? AND revoked = 0'
);
const listStmt = db.prepare(
  `SELECT id, label, revoked, created_at, last_used_at, (revoked = 0) AS active
   FROM mcp_tokens ORDER BY id DESC`
);
const revokeStmt = db.prepare('UPDATE mcp_tokens SET revoked = 1 WHERE id = ?');
const touchStmt = db.prepare("UPDATE mcp_tokens SET last_used_at = datetime('now') WHERE id = ?");
const hasActiveStmt = db.prepare(
  'SELECT EXISTS(SELECT 1 FROM mcp_tokens WHERE revoked = 0) AS n'
);

// Create a token. Returns { token, row } — `token` (the raw secret) is returned ONCE for the
// owner to copy into an agent config and never persisted; only its HMAC is stored.
export const createMcpToken = db.transaction(({ label }, secret) => {
  const token = newToken();
  const info = insert.run({
    token_hash: hashToken(token, secret),
    label: (label || '').trim(),
  });
  return { token, row: getById.get(info.lastInsertRowid) };
});

// Resolve a raw token to its row IFF it is unrevoked — revocation enforced in SQL.
// Returns the row or undefined.
export function resolveMcpToken(token, secret) {
  return getActiveByHash.get(hashToken(token, secret));
}

// Management list for the owner UI — never includes a usable token (raw tokens aren't stored).
export function listMcpTokens() {
  return listStmt.all();
}

export function revokeMcpToken(id) {
  return revokeStmt.run(id).changes;
}

// Stamp last_used_at — called by lib/mcp-auth.js on every successful DB-token verify.
export function touchMcpToken(id) {
  return touchStmt.run(id).changes;
}

// True iff at least one unrevoked token exists — feeds mcpConfigured() (503 gate).
export function hasActiveMcpTokens() {
  return hasActiveStmt.get().n === 1;
}

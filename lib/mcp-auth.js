import crypto from 'node:crypto';
import { authSecret } from './secret.js';
import { resolveMcpToken, touchMcpToken, hasActiveMcpTokens } from './mcp-token-writes.js';

// MCP auth boundary: a presented credential is valid if it matches the KIN_MCP_TOKEN env var
// (the original single-token deploy model, kept as a fallback so existing setups keep working)
// OR an unrevoked row in mcp_tokens (minted in-app on /settings, v9). Env is checked first —
// a pure constant-time compare with no secret/DB dependency — then the DB path (HMAC keyed by
// AUTH_SECRET, revocation enforced in SQL, last_used_at stamped on success).

const MIN_LEN = 24;

// The configured env token, or null if unset / too short to be a real secret.
function envToken() {
  const t = process.env.KIN_MCP_TOKEN;
  return typeof t === 'string' && t.length >= MIN_LEN ? t : null;
}

// True iff any credential could authenticate: env token set OR ≥1 active DB token.
// Unconfigured → the routes return 503, never open-access (mirrors /api/parse).
export function mcpConfigured() {
  return envToken() !== null || hasActiveMcpTokens();
}

// Length of a minted token: newToken() = crypto.randomBytes(32).toString('hex').
const TOKEN_LEN = 64;

// Constant-time compare against the env token. Never branches on secret contents. Compare
// string lengths BEFORE allocating Buffers so a huge presented value can't force a large
// allocation (the token is ASCII/hex, so char length == byte length); the check also avoids a
// throw from timingSafeEqual on unequal buffers. (`token === null` = env fallback not set.)
function verifyEnvToken(presented) {
  const token = envToken();
  if (token === null || typeof presented !== 'string') return false;
  if (presented.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(token));
}

// DB-token check: HMAC the presented value and look up an unrevoked row. Minted tokens are
// always 64 hex chars, so reject any other length before an HMAC + DB round-trip. A missing
// AUTH_SECRET fails CLOSED here (never an unkeyed lookup) — the routes surface that state as a
// 500 via assertMcpAuthReady() rather than letting it masquerade as a bad token.
function verifyDbToken(presented) {
  if (typeof presented !== 'string' || presented.length !== TOKEN_LEN) return false;
  let secret;
  try {
    secret = authSecret();
  } catch {
    return false;
  }
  const row = resolveMcpToken(presented, secret);
  if (!row) return false;
  touchMcpToken(row.id);
  return true;
}

export function verifyKinToken(presented) {
  return verifyEnvToken(presented) || verifyDbToken(presented);
}

// Loud-failure pre-check for the routes: minted tokens exist but AUTH_SECRET is missing, so
// none of them can ever verify. Routes map the throw to 500 'AUTH_SECRET is not configured'
// (crypto fail-loud rule) instead of collapsing the state into 401s. A no-op in env-only
// mode — an env-token deploy works without any DB tokens.
export function assertMcpAuthReady() {
  if (!hasActiveMcpTokens()) return;
  authSecret(); // throws with a clear message when missing/short
}

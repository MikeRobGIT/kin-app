import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Codifies the rule in .claude/rules/kin.md: "Every route: export const dynamic =
// 'force-dynamic' + guard()/isAuthed() -> 401. The proxy.js gate is convenience only, never the
// security boundary." Walks every app/api/**/route.js file, imports it through the same loader
// hook route-subscriptions.test.js uses, and checks both halves for every route NOT on the
// EXEMPT allowlist below — so a brand-new route that forgets either one fails this test instead
// of shipping unguarded.
//
// DATA_DIR / AUTH_SECRET must exist and the loader hook must be registered before ANY dynamic
// import below (lib/db.js opens the DB at import time; authSecret() throws on a short/missing
// secret).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-route-auth-'));
process.env.AUTH_SECRET = '0123456789abcdef0123456789abcdef';
register('./helpers/route-loader.mjs', import.meta.url);

const { destroySession } = await import('../lib/auth.js');

const ROOT = path.resolve(new URL('../', import.meta.url).pathname);
const API_DIR = path.join(ROOT, 'app', 'api');

// Routes that are deliberately public or authenticate a different way than the session cookie.
// Keyed by the route's path relative to app/api (no trailing /route.js). A route NOT listed here
// is assumed to be session-cookie-guarded, so a new one that isn't fails loudly below rather than
// silently joining an ever-growing "trust me" list.
const EXEMPT = {
  'auth/login': "mints the session — by definition it must run with no session yet",
  'auth/logout': 'clears the session cookie; must succeed whether or not one exists (idempotent)',
  'auth/me': "reports auth status by design — GET intentionally returns 200 {authed:false} rather than 401",
  health: 'unauthenticated Docker/Coolify liveness probe (runs SELECT 1 only, exposes no data)',
  '[transport]': 'MCP server transport — bearer token via withMcpAuth, not the session cookie',
  'link/[token]/[transport]':
    'MCP capability URL — the [token] path segment IS the credential, not the session cookie',
};

// Every route here is imported for real — none is checked by reading its source text.
//
// That was not always true. app/api/[transport] used to build its MCP handler at module TOP LEVEL
// (`withMcpAuth(makeKinHandler(...))`), and makeKinHandler registers the full tool set and leaves an
// open handle nothing closes — so merely importing that module hung `node --test` forever on Node 20
// (no --test-force-exit), even after every assertion had passed. It was therefore source-text-checked
// instead, which silently weakened the rule: a regex cannot tell a real `export const dynamic` from
// one inside a comment or a string. Both MCP routes now build their handler lazily on first request
// (app/api/link/[token]/[transport] always did), so both import cleanly and get the real check.
//
// Keep it that way. If a future route hangs this file, make the route lazy rather than adding a
// source-text escape hatch here — the escape hatch is what let the gap hide.

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function findRouteFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findRouteFiles(full));
    else if (entry.name === 'route.js') out.push(full);
  }
  return out;
}

const files = findRouteFiles(API_DIR).sort();
// Guards the walk itself: if this ever comes back empty or tiny, every test below would
// vacuously "pass" having checked nothing, and a rule about UNGUARDED routes went untested for
// the exact reason route-level tests didn't exist before this file.
assert.ok(files.length >= 20, `expected to find the app/api route.js files, found ${files.length}`);

for (const file of files) {
  const key = path.relative(API_DIR, path.dirname(file)).split(path.sep).join('/');
  const exemptReason = EXEMPT[key];

  test(`app/api/${key} — dynamic export + auth guard`, async () => {
    const mod = await import(pathToFileURL(file).href);
    assert.equal(
      mod.dynamic,
      'force-dynamic',
      `app/api/${key}: missing "export const dynamic = 'force-dynamic'"`
    );

    if (exemptReason) return; // reason documented in EXEMPT above; not session-cookie-guarded

    await destroySession(); // every check below must see NO session

    const methods = METHODS.filter((m) => typeof mod[m] === 'function');
    assert.ok(methods.length > 0, `app/api/${key}: exports no recognizable HTTP method`);

    for (const method of methods) {
      const request = new Request(`http://localhost/api/${key}`, { method });
      let res;
      try {
        res = await mod[method](request, { params: Promise.resolve({ id: 'x' }) });
      } catch (e) {
        // A route that THROWS instead of cleanly 401ing without a session is itself a finding
        // (it means something ahead of the auth guard can run unauthenticated) — fail loud
        // rather than swallow it.
        assert.fail(`app/api/${key} ${method}: threw instead of returning 401 — ${e.stack || e}`);
      }
      assert.equal(
        res.status,
        401,
        `app/api/${key} ${method}: expected 401 with no session, got ${res.status}`
      );
    }
  });
}

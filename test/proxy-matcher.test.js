import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The compiled path-to-regexp is CJS without an ESM directory entry — require it.
const { parse, tokensToRegexp } = createRequire(import.meta.url)(
  'next/dist/compiled/path-to-regexp'
);

// Pin the auth perimeter: compile proxy.js's matcher exactly as Next does
// (build: parse + tokensToRegexp; runtime: new RegExp(source) — which drops the
// `i` flag, so matching is case-sensitive). The matcher regex MATCHES paths the
// proxy runs on; excluded public assets must NOT match. (IB-13 #24.)
const src = readFileSync(new URL('../proxy.js', import.meta.url), 'utf8');
const m = /matcher:\s*\['([^']+)'\]/.exec(src);
// The capture is raw source text, so JS string escapes are unprocessed — collapse
// the source-level `\\` into the `\` the runtime string actually contains.
const re = new RegExp(tokensToRegexp(parse(m[1].replace(/\\\\/g, '\\'))).source);

test('proxy matcher: exact public assets bypass the gate', () => {
  for (const p of ['/favicon.ico', '/icon.svg', '/apple-icon.png', '/manifest.webmanifest']) {
    assert.equal(re.test(p), false, `${p} should be excluded`);
  }
});

test('proxy matcher: prefix/suffix abuse of asset names stays gated', () => {
  for (const p of [
    '/icon.svg.hack',
    '/manifest.webmanifestfoo',
    '/favicon.ico.x',
    '/apple-icon.png.x',
    '/apple-icon.svg',
    '/faviconXico',
  ]) {
    assert.equal(re.test(p), true, `${p} should be gated`);
  }
});

test('proxy matcher: pages gated; api and _next stay prefix-excluded by design', () => {
  for (const p of ['/', '/login', '/settings', '/report', '/share/abc']) {
    assert.equal(re.test(p), true, `${p} should enter the proxy`);
  }
  for (const p of ['/api/events', '/_next/static/x.js', '/_next/image?u=1'.split('?')[0]]) {
    assert.equal(re.test(p), false, `${p} should be excluded`);
  }
});

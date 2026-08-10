// ESM resolve hook that makes an App Router route module importable under `node --test`.
//
// Two things stop plain node from loading `app/api/**/route.js`:
//   1. `@/lib/x` — a jsconfig path alias Next understands and node does not.
//   2. `next/headers` — pulls in a request context that only exists inside a Next server.
//
// Registered via node:module `register()` (Node >= 20.6), which runs hooks on a separate thread but
// only rewrites the SPECIFIER. The resolved module still loads in the main realm, so the cookie jar
// in next-headers-stub.mjs is the very object lib/auth.js reads — a test can set a session and the
// route sees it.
//
// Deliberately narrow: it maps two things and delegates everything else to nextResolve. It is test
// infrastructure, not a bundler.
import { pathToFileURL } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const STUB = new URL('./next-headers-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/headers') {
    return { url: STUB, shortCircuit: true };
  }
  if (specifier.startsWith('@/')) {
    // Next resolves an alias extensionless (`@/lib/db`); node needs the real filename.
    const base = path.join(ROOT, specifier.slice(2));
    const target = [base, `${base}.js`, path.join(base, 'index.js')].find(
      (p) => existsSync(p) && statSync(p).isFile()
    );
    if (!target) throw new Error(`route-loader: cannot resolve "${specifier}" under ${ROOT}`);
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  // Next's package exports resolve `next/server` for the bundler, not for bare node ESM, which wants
  // the extension. NextResponse itself is a thin Response subclass and works fine outside a server.
  if (specifier === 'next/server') {
    return nextResolve('next/server.js', context);
  }
  return nextResolve(specifier, context);
}

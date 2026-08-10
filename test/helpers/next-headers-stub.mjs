// Stand-in for `next/headers`, swapped in by test/helpers/route-loader.mjs so a route handler can be
// imported and called under `node --test` with no Next request context.
//
// Route handlers reach auth through `cookies()` (lib/auth.js isAuthed). That is the ONLY reason a
// route module cannot be imported directly in a test, and it is why this repo had no route-level
// coverage until now — the seam between a validator and the row a route builds went untested, which
// is how a merge that made every PUT 400 survived two commits.
//
// State lives in the main realm: the loader only redirects the specifier, so the module object the
// test mutates is the same one lib/auth.js receives.
let jar = new Map();

/** Set the session cookie a subsequent route call will see. */
export function __setCookie(name, value) {
  jar.set(name, { name, value });
}

/** Drop every cookie — the logged-out case. */
export function __clearCookies() {
  jar = new Map();
}

// Next's cookies() is async in the App Router (Next 15+), and lib/auth.js awaits it.
export async function cookies() {
  return {
    get: (name) => jar.get(name),
    getAll: () => [...jar.values()],
    has: (name) => jar.has(name),
    set: (name, value) => jar.set(name, { name, value }),
    delete: (name) => jar.delete(name),
  };
}

export async function headers() {
  return new Map();
}

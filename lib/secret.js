// The AUTH_SECRET env policy, in a Next-free module so server libs and node:test can import
// it — lib/auth.js pulls in next/headers, which only resolves inside a Next build/runtime.
// Fail-loud per the house crypto rule: never fall back to an empty/default key.
export function authSecret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      'AUTH_SECRET is missing or too short. Set a long random value in your environment.'
    );
  }
  return s;
}

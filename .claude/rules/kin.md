# Kin rules (mistake registry)

`/improve-next` reads these before implementing (Step 3) and codifies new defects back here
(Step 10). Each rule is a real lesson — keep them concrete.

## Build / native module
- **Never touch the data volume during `next build`.** `lib/db.js` opens an in-memory DB when
  `NEXT_PHASE === 'phase-production-build'`. Build's parallel page-data workers each import routes
  → `lib/db.js`; on a shared file they contend on the write lock past `busy_timeout` → SQLITE_BUSY
  deploy failure. Keep the `:memory:` build-phase branch. (Real failure, fixed in `eb6a07f`.)
- All npm/node commands need **Node 20** (`nvm use 20`) — better-sqlite3's native addon won't
  build on the default Node 25 + broken Xcode CLT.
- Keep `output: 'standalone'` and `serverExternalPackages: ['better-sqlite3']` working.

## Migrations
- Append a new function to the `migrations` array in `lib/migrate.js`; index+1 = `user_version`.
  **Never edit an existing migration.** New-tables-only is safe (FK gate passes trivially). A table
  rebuild must keep a row-count guard and rely on the runner's FK-off + `foreign_key_check`.
- A migration that can orphan FK rows must repair (→ NULL) or abort with an actionable error —
  an unrepaired orphan crash-loops the container on boot. (Real: caregiver_id/child_id orphans.)
- **When a migration adds a persisted table, also add it to `lib/export.js buildExport`** — it claims
  a "complete dump" but enumerates a fixed table list, so new tables are silently dropped from the
  backup/handoff (the v5 schedule tables were missing; month_seals would have been). (IB-05 #9, codex.)
- **Migration-on-boot must survive a locked DB — Litestream + a container swap will race it.** During
  a deploy the old and new containers briefly share the data volume while Litestream replicates it, so
  the new container's boot migration (a write) can lose the lock and throw `SQLITE_BUSY` at `lib/db.js`
  import time → every DB route 500s, and the auto-deploy needs a manual restart to recover. `lib/db.js`
  sets `busy_timeout = 20000` and wraps the snapshot+`runMigrations` in `runWithBusyRetry` (retries on
  `SQLITE_BUSY`, rethrows real errors). Keep both; a code-only deploy (no pending migration) has no boot
  write, so shipping this kind of fix is safe. (Real: the v8 recurring-events deploy, 2026-07-01 — the
  runtime/Litestream variant of the build-time SQLITE_BUSY rule above.)

## API routes
- Every route: `export const dynamic = 'force-dynamic'` + `guard()`/`isAuthed()` → 401. The
  `proxy.js` gate is convenience only, never the security boundary.
- Validate server-side in `lib/validate.js`; PUT/DELETE do a 404 pre-check before the write
  helper (the audit insert has a NOT NULL snapshot and will roll back on a missing row).
- Writes go through the transactional helpers that append an audit snapshot — don't write rows
  ad hoc in a route.

## Auth / cookies
- Session cookie is `httpOnly` + `secure`-in-production. **Never enter the password into a field.**
  Browser-verify authed pages on the dev server (non-secure cookie) by injecting a minted
  `tt_session` token via `document.cookie`.
- **A crypto feature that keys on a secret must fail loudly if the secret is missing/short** — never
  fall back to an empty/default key (`String(secret ?? '')` silently produces an unkeyed, worthless
  HMAC). Use `authSecret()` (lib/auth.js, throws on missing/<16-char) and 500 on failure. (IB-05 #9 —
  local reviewer + gemini security-high.) Keep the env-policy at the boundary (route/page via
  `authSecret()`), not inside the pure crypto primitive — the primitive stays a dumb HMAC.
- **A public, login-less route (capability link) must:** be a high-entropy random token, store only
  its HMAC (never the raw token), enforce expiry+revocation server-side IN the lookup query, render
  read-only and scoped (no mutations, no other data/routes), fail to a single generic message (no
  expired-vs-revoked-vs-unknown leak), and set `Cache-Control: private, no-store` (an intermediary
  proxy must not cache a report past revocation). Wave it past the proxy cookie-gate by EXACT segment
  count (`/share/<token>` = 3 segments), not a bare `startsWith`, so a future authed page under the
  same prefix isn't accidentally un-gated. (IB-06 #10.)

## Client state
- When restoring a *remembered* selection (a `useRef`/localStorage value, e.g. sticky add
  defaults) into a `<select>`, **validate the id still exists in the current options before
  using it**, falling back to the first option — a stale id renders an invalid `<select>` value
  and 400s on save. Treat the empty string ("not specified") as a valid sticky value.
  (IB-01 #5, caught by gemini-code-assist.)

## Data fetching / dates
- **An "optional" secondary fetch in a `Promise.all` must `.catch` to a sentinel** (e.g.
  `fetch(url).catch(() => ({ ok: false }))`) — otherwise a network *rejection* (not just a non-OK
  response) rejects the whole batch and fails the primary load, contradicting "this part is optional."
  On the non-OK/failure path, **clear the dependent state** (don't leave stale values for a new range)
  AND make the dependent UI **hide** rather than render a misleading default (e.g. gate the overnights
  section on *assigned* nights, so a failed/absent schedule hides it instead of showing all-"Unassigned").
  (IB-04 #8 — gemini HIGH + codex P2; the local reviewer missed it. Different model families catch
  different defects — keep both review lanes.)
- **Iterate a date range by integer day offset, not Date `<=` comparison.** Use
  `for (let i=0; i<=Math.round((end-start)/MS_PER_DAY); i++) { const d=new Date(start); d.setDate(d.getDate()+i); }`
  (the `dayIndex` idiom). A midnight-DST shift can make the last day's Date compare greater than `end`
  and silently drop a night — wrong in a custody/legal count. (IB-04 #8.)

## UI / layout
- Adding a control to a **fixed-width flex row** (e.g. `.modal-actions`, where `.btn{flex:1}` and the
  modal is `max-width:430px` inside a `padding:20px` overlay) can overflow at narrow viewports. A 4th
  button pushed the edit-modal action row past a 375px-phone modal (~283px content) → horizontal
  overflow. `flex-wrap:wrap` on the row fixes it (wraps to 2 lines; desktop unchanged). Unit tests,
  the build gate, AND the local code reviewer all missed this — **only the 375px browser-verify caught
  it**. When you add a button/field to a flex row, check the ≤375px render. (IB-02 #6.)
- `claude-in-chrome` `resize_window` may not actually narrow the viewport here (`innerWidth` stayed
  wide). To verify narrow layout, clamp the element (`el.style.width`) + read `getComputedStyle` /
  `scrollWidth>clientWidth`, or predict-from-data — don't trust the resize alone.
- **A `.report-table` with two datetime columns overflows a 375px page** (settings token list:
  Label + Created + Last used + Status + Revoke → scrollWidth 384 > clientWidth 360). Wrap wide
  data tables in `.table-scroll` (`overflow-x:auto`) so the TABLE pans instead of the PAGE
  overflowing. Same lesson-class as the flex-row rule above — unit tests + build were green;
  **only the 375px browser-verify caught it** (Playwright, MCP-token settings page).
- **Every new `aria-modal` overlay must move focus inside it on open** — `autoFocus` a child (the edit
  & backfill modals autoFocus their first input; the agenda autoFocuses its Close button). Without it,
  focus stays on the trigger behind the overlay, so `trapTab` never engages (its `activeElement ===
  first/last` checks can't match) and the focus-restore effect is meaningless. Caught on IB-03 #7 by
  the local reviewer AND both remote bots (gemini + codex) — a recurring a11y defect, check it.
- **Focus-restore for a conditionally-MOUNTED modal lives in the HOST, not the modal.** Two traps in
  one: (1) capturing `document.activeElement` in the modal's effect (or even a mount effect) is too
  late — `autoFocus` moves focus during commit, before effects; (2) a restore in the modal's
  mount-effect *cleanup* fires once ON OPEN under dev StrictMode's setup→cleanup→setup, yanking focus
  back behind the overlay exactly where browser-verify runs. Correct pattern (Calendar + Settings):
  capture the opener in the *click handler* into a host ref, restore in a host effect gated on the
  open flag (cleanup only exists while open, so the mount double-invoke can't fire it). (IB-09 #20 —
  local reviewer caught the StrictMode variant; gemini flagged the render-phase `document` read.)

## Process
- **Never pipe the test gate** (`npm test | tail …`) **and call it green.** The pipeline's exit
  status is the LAST command's (tail's), so a `&&` chain happily commits/pushes on a red suite, and
  a truncated tail can hide the `# fail N` line itself. Gate = run `npm test` unpiped (or
  `set -o pipefail`) AND read the explicit `# pass / # fail` counts before any commit/push in the
  same chain. (Real failure on IB-07 #18: a red test was amended+pushed; caught only by a later
  explicit count check.)
- **No `Co-Authored-By`** anywhere. **Never self-merge.**
- Deploy = push to `main` (Coolify auto-deploys kin.example.com); Litestream→R2 runs in-container.
- **This repo is public and is now the only repo** (the private dev repo was retired). There is
  no staging area to catch a slip before it ships — every commit, PR, comment, and backlog entry
  here is world-readable the moment it's pushed. Never commit real names, a real deployment URL,
  or any other personal/identifying detail; use the existing fictional examples (`Ivy`, `Owen`,
  `Carter`, `kin.example.com`) for anything that needs a concrete-looking example.

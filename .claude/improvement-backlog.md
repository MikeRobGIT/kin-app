# Kin improvement backlog

`/improve-next` picks the topmost `status: ready` item (or a named `<item-id>`).
`risk: high` items require an explicit id to start. Keep newest-done at the bottom.

---

## IB-01 — Smart add defaults (now + sticky child/caregiver)
- status: done (#5)
- risk: low
- acceptance: The "+ Add Event" button (no slot preset) defaults the time to the current
  hour rounded to the nearest sensible slot instead of the hardcoded `08:00`, and the modal
  remembers the last-used `child_id` and `caregiver_id` for the session instead of always
  defaulting to the first. Clicking a time slot still uses that slot's hour. Editing an
  existing event is unchanged. Browser-verified: Add Event at different times prefills ~now;
  after saving with a given child/parent, the next Add prefills the same.

## IB-02 — Duplicate / repeat-last entry
- status: done (#6)
- risk: low
- acceptance: From an event's edit modal, a "Duplicate" action opens the Add modal pre-filled
  with that event's fields (date defaulting to the selected day), and saving creates a new
  event with its own audit `create` row. Browser-verified.

## IB-03 — Today / Tomorrow agenda
- status: done (#7)
- risk: low
- acceptance: A compact, read-only "next 2 days" agenda (today + tomorrow), each with its
  events in time order and the parent-on-duty, reachable from the controls. No CRUD. Browser-verified.

## IB-04 — Overnight / custody-split ledger
- status: done (#8)
- risk: medium
- acceptance: The involvement report (`/report`) gains an "Overnights" section that counts
  overnights per parent over the selected range and shows the split %, computed from the
  parent-time schedule + overrides (`lib/schedule.js parentOnDate` per night) — no new event
  rows. Pure computation is unit-tested. `npm run build` green.

## IB-05 — Monthly cryptographic seal
- status: done (#9)
- risk: medium
- acceptance: "Seal" a month → persist a SHA-256 over that month's canonical record + an
  HMAC keyed by `AUTH_SECRET`; a verify endpoint recomputes and reports match/tamper. Append
  a v6 migration (new table). Sealing + verification are unit-tested. Capstone to the
  record-integrity work.

## IB-06 — Lawyer share link
- status: done (#10)
- risk: high
- acceptance: An expiring, read-only, HMAC-signed `/share/<token>` URL that renders the
  involvement report without a login — a capability token, NOT an account (stays single-user).
  Token carries an expiry enforced server-side. Security-sensitive: tightly scope what the
  token exposes (read-only report, no mutations, no other routes). Unit-tested token sign/verify.

## IB-07 — DRY the DST-safe day iterator (schedule.js)
- status: done (#18)
- risk: low
- acceptance: `lib/mcp-tools.js listEvents` re-implements the integer-day-offset loop + YMD
  formatter that `lib/schedule.js overnightCounts` already contains. Extract an exported
  `eachDay(from, to, fn)` + `ymdLocal(d)` in `lib/schedule.js` and have BOTH `overnightCounts`
  and `listEvents` call it. Behavior-preserving: the existing `schedule.js` + `mcp-tools`
  tests must stay green with zero edits (overnightCounts is custody-critical — the green run is
  the proof). Surfaced by the MCP PR review (#14), deferred to keep that PR surgical.

## IB-08 — CI test workflow (GitHub Actions)
- status: done (#19)
- risk: low
- acceptance: A GitHub Actions workflow (check name `test`) runs `npm test` on every PR and on
  push to `main`, on Node 20, with `TZ=America/New_York` so the DST-boundary tests in
  `test/schedule.test.js` actually exercise a DST zone (they're vacuous under UTC — IB-07 review
  note). `npm ci` + native better-sqlite3 must work on ubuntu-latest. No deploy coupling — Coolify
  keeps deploying on push to main independently of this check.

## IB-09 — ScheduleManager modal a11y parity (trapTab + Escape)
- status: done (#20)
- risk: low
- acceptance: The parent-time modal traps Tab like the edit/backfill/agenda modals (lift Calendar's
  `trapTab` helper somewhere shareable and reuse it — don't fork a second copy) and closes on
  Escape (not while a save is in flight), restoring focus to the opener button on /settings.
  Existing autoFocus behavior unchanged. Browser-verified from /settings: Tab cycles inside the
  modal, Escape closes, focus returns to "Manage parent time".

## IB-10 — DRY client-side ymd/pad helpers into lib/schedule.js
- status: done (#21)
- risk: low
- acceptance: `components/Calendar.js`, `components/ScheduleManager.js`, and
  `components/Settings.js` drop their local `ymd`/`pad` duplicates and import `ymdLocal` from
  `lib/schedule.js` (client-safe, no DB import chain); keep a local `pad` only where it formats
  something `ymdLocal` doesn't cover (e.g. HH:MM). Behavior-preserving: all existing tests green
  with zero edits, build green, calendar/settings render identically (browser-verified).

## IB-12 — trap-tab hardening (disabled controls, Escape defaultPrevented)
- status: done (#22)
- risk: low
- acceptance: `lib/trap-tab.js` skips disabled controls when picking first/last (a disabled
  first/last makes `.focus()` a no-op after `preventDefault()`, so Tab can stick), and the
  modal Escape handlers ignore `e.defaultPrevented` (Escape while a native `<select>` dropdown
  is open shouldn't also close the modal). Applies to all four modals uniformly. Surfaced by the
  IB-09 #20 review; deferred there because the item required a verbatim lift. Browser-verified.

## IB-11 — PWA web app manifest (home-screen install)
- status: done (#23)
- risk: medium
- acceptance: `app/manifest.js` metadata route serves a valid manifest (name Kin, standalone
  display, terracotta theme/background colors, the existing icon assets); `proxy.js` allowlist
  admits the manifest URL (and every icon path it references) so nothing 307s to /login (the
  known proxy-gate gotcha from the favicon work). Browser-verified: manifest fetches 200
  unauthenticated with valid JSON, icons it references load, no console errors on /login.

## IB-13 — Anchor the proxy matcher's filename exclusions
- status: done (#24)
- risk: low
- acceptance: The `proxy.js` matcher's negative-lookahead filename alternatives are escaped and
  anchored (`favicon\.ico$|icon\.svg$|apple-icon\.png$|manifest\.webmanifest$`) so only the exact
  public paths bypass the cookie gate — today `/icon.svg.hack` or `/manifest.webmanifestfoo` are
  un-gated prefix matches (blast radius is only the 404 page, and page-level `isAuthed()` holds,
  but the perimeter should say what it means). `api|_next/*` prefixes stay prefixes on purpose.
  Verify: manifest/icons still 200 without a session; `/icon.svg.hack` 307s to /login; all pages
  still gate. Surfaced by the IB-11 #23 review.

## IB-14 — seal.js: fail loud on a missing/short AUTH_SECRET (no empty-key fallback)
- status: ready
- risk: low
- acceptance: `lib/seal.js sealMonth`/`verifySeal` currently HMAC with `String(secret ?? '')`
  (lib/seal.js:57) — the empty-key fallback `.claude/rules/kin.md` explicitly bans (an unkeyed,
  worthless HMAC if the secret is ever missing). Route callers already pass `authSecret()` (which
  throws on missing/<16-char), so in practice it's dead defensive code — but the primitive should
  not silently accept a falsy key. Make `sealMonth`/`verifySeal` reject a missing/short secret
  (mirror the `authSecret()` policy at the boundary, or assert a non-empty key in the primitive)
  so a misconfigured deploy fails loudly instead of producing a forgeable seal. Unit-tested;
  existing seal tests stay green. Surfaced by the IB-family (#27) pre-merge review, out of that
  PR's scope.

---

## Done
- IB-13 proxy matcher anchoring — done (#24): filename exclusions escaped + `$`-anchored
  (`/icon.svg.hack` etc. now gated; api|_next stay prefixes by design); the perimeter is pinned
  by `test/proxy-matcher.test.js`, which compiles the matcher through Next's own path-to-regexp
  (remember: the literal is extracted from raw source, so source `\\` must be collapsed to `\`
  before compiling).
- IB-11 PWA manifest — done (#23): `app/manifest.js` metadata route (auto-linked, served at
  `/manifest.webmanifest`; Kin / standalone / paper bg / terracotta theme; existing icons only)
  + proxy matcher allowlist entry (the favicon-work gotcha, applied proactively). Matcher
  anchoring follow-up filed as IB-13.
- IB-12 trap-tab hardening — done (#22): `lib/trap-tab.js` filters disabled controls before
  picking first/last (disabled edge froze Tab or leaked the trap); both Escape handlers
  (Calendar overlay effect + ScheduleManager) ignore `e.defaultPrevented` so a native
  `<select>`-picker dismiss can't also close the modal.
- IB-10 ymd DRY — done (#21): Calendar/ScheduleManager/Settings alias-import `ymdLocal as ymd`
  from lib/schedule.js (call sites untouched); extended in-PR to the reviewer-found leftovers
  Report.js (same alias; keeps `pad` for HH:MM like Calendar) and lib/recurrence.js (private
  copy + its `pad` replaced by the shared import). One formatter, five former copies gone.
- IB-09 parent-time modal a11y — done (#20): `lib/trap-tab.js` (verbatim lift, shared by all four
  modals), Escape-close guarded by `!busy`, focus restore via Settings `ptOpenerRef` captured in
  the opener's click handler + effect gated on `ptOpen` (in-component mount-effect cleanup would
  fire on open under dev StrictMode — reviewer-caught). Follow-up hardening filed as IB-12.
- IB-08 CI test workflow — done (#19): `.github/workflows/test.yml` — `npm ci` + `npm test` on
  Node 20, ubuntu-latest, `TZ=America/New_York` (makes the DST tests real), `permissions:
  contents: read`, `timeout-minutes: 10`. Check name `test`; first run green in 24s.
- IB-07 eachDay/ymdLocal extraction — done (#18): `lib/schedule.js` exports `eachDay(from,to,fn)`
  (inclusive, DST-safe integer-offset loop, zero iterations on bad/reversed range) + `ymdLocal(d)`;
  `overnightCounts` and `lib/mcp-tools.js listEvents` both use them. Behavior-preserving — the 166
  pre-existing tests passed with zero edits; 6 new unit tests pin the extracted helpers (incl. both
  DST boundaries).
- IB-06 lawyer share link — done (#10): login-less, expiring, revocable `/share/<token>` (v7
  `share_tokens`, HMAC-of-token stored, expiry/revoke enforced in SQL); public server page renders
  the full report read-only, scoped to a baked-in range; owner UI on `/report` (create/list/revoke).
  `lib/share.js` + `lib/share-writes.js` + `lib/report.js` (summary extracted, shared with the
  authed report). Token sign/verify + migration + create/resolve/expiry/revoke unit-tested.
- IB-05 monthly seal — done (#9): v6 `month_seals` table + `lib/seal.js` (canonical month =
  events incl. timestamps + per-night `parentOnDate`; SHA-256 + HMAC-`AUTH_SECRET`),
  `/api/seals` (seal/list) + `/api/seals/verify`, report "Record seals" UI (seal/verify/history,
  re-seal keeps history). Also made `buildExport` complete (added schedules/overrides/
  schedule_audit/month_seals — they were silently omitted). Pure crypto + migration unit-tested.
- IB-04 overnights ledger — done (#8): `/report` "Overnights" section — `lib/schedule.js
  overnightCounts(from,to,schedules,overrides)` (one night/date via `parentOnDate`, DST-safe
  integer loop), `components/Report.js` fetches `/api/schedules`, gates the section on assigned
  nights so a failed/absent schedule hides it. Pure fn unit-tested.
- IB-03 today/tomorrow agenda — done (#7): read-only "📋 Next 2 days" overlay (today + tomorrow,
  parent-on-duty + events in time order), event rows reuse `.chip` (`.chip-ro` drops the click
  affordance). `components/Calendar.js` agenda overlay + `openAgenda`/`agendaDays`.
- IB-02 duplicate entry — done (#6): "Duplicate" action in the edit modal reopens it as a fresh
  Add (date → day in view), saving POSTs a new event with its own `create` audit row.
  `components/Calendar.js` `duplicate()` + `.modal-actions{flex-wrap}` for the 4-button row.
- IB-01 smart add defaults — done (#5): now-time default + sticky last-added child/caregiver,
  validated against current options. `lib/format.js defaultEventTime` + `components/Calendar.js`.
- parent-time scheduling — done (`8e47dda`, deployed 2026-06-20): presets + custom rotations,
  holiday/summer overrides, configurable parent names, calendar overlay. Superseded the old
  "schedule ahead" idea.

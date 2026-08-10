# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Kin — a self-hosted calendar for tracking what each parent does for two kids:
transport (school, tutoring, therapy, daycare, sports, gymnastics) plus hands-on
care, with a per-parent involvement report. Single-user, deployed on Coolify via
docker-compose. Week / day / month views, color-coded by child and activity type.

## Stack

- **Next.js 14** (App Router) — UI and API route handlers in one deployable app.
- **better-sqlite3** — synchronous SQLite, persisted at `DATA_DIR` (`/app/data` in
  Docker, mounted to a named volume). Native module.
- **Auth** — single password via `APP_PASSWORD`; HMAC-signed session cookie keyed
  by `AUTH_SECRET`. No accounts table, no auth library.
- Plain CSS in `app/globals.css`. No UI framework, no state library.

## Layout

- `app/page.js` — home; renders `components/Calendar.js`.
- `app/login/page.js` — login screen (client component).
- `components/Calendar.js` — the whole UI: week/day/month views, add/edit modal,
  the parent-time overlay, CRUD calls to the API. Client component.
- `components/ScheduleManager.js` — parent-time manager modal (rotation presets +
  custom, holiday/summer overrides). Rotation/override selects list ACTIVE parents only.
  Client component. (Parent add/rename/recolor/archive lives in the Family section on
  `/settings`, not here.)
- `app/api/events/route.js` — `GET` (list, optional `from`/`to` range) and `POST`.
- `app/api/events/[id]/route.js` — `PUT` and `DELETE`.
- `app/api/schedules/route.js` — `GET` → `{schedules, overrides}`, `POST`.
- `app/api/schedules/[id]/route.js`, `app/api/overrides/route.js`,
  `app/api/overrides/[id]/route.js` — schedule + override CRUD.
- `app/api/children/route.js` (`GET` all / `POST` create) + `app/api/children/[id]/route.js`
  (`PUT` rename/recolor/archive); `app/api/caregivers/route.js` (`GET` all / `POST` create) +
  `app/api/caregivers/[id]/route.js` (`PUT` rename/recolor/archive). Family roster CRUD (v11).
- `app/api/auth/{login,logout,me}/route.js` — session endpoints.
- `app/settings/page.js` → `components/Settings.js` — settings page; the Family manager
  (children + parents: add/rename/recolor/archive), parent-time manager, and mints/lists/revokes
  MCP agent tokens (raw token shown once, HMAC-only storage).
- `app/api/mcp-tokens/route.js` + `[id]/route.js` — token mint/list/revoke API.
- MCP server: `app/api/[transport]/route.js` (bearer, `/api/mcp`) +
  `app/api/link/[token]/[transport]/route.js` (capability URL); tools in `lib/mcp-tools.js`
  (registered via `lib/mcp-server.js`), auth in `lib/mcp-auth.js` (minted DB token OR
  `KIN_MCP_TOKEN` env fallback), writes in `lib/mcp-token-writes.js`.
- `lib/db.js` — opens the DB, creates schema, seeds the two children + two parents.
- `lib/auth.js` — `checkPassword`, `createSession`, `destroySession`, `isAuthed`;
  `authSecret` policy lives in `lib/secret.js` (Next-free, importable in tests).
- `lib/constants.js` — `TYPES` (activity types + colors) and `PD` (trip kinds).
- `lib/schedule.js` — pure parent-time engine (`parentOnDate`, `PRESETS`, …);
  `lib/schedule-writes.js` — transactional schedule/override writes; `lib/family-writes.js` —
  children/caregivers create/rename/recolor/archive (mints `c*`/`g*` ids; never deletes).
- `lib/validate.js` — server-side validation for events, schedules, overrides, and family
  members (`validateFamilyCreate`/`validateFamilyUpdate` + `activeNameTaken`), plus subscriptions
  (`validateSubscription`/`validateSubscriptionPatch`/`validateChildMap`).
- iCal feeds: `app/api/subscriptions/route.js` (`GET`/`POST`), `[id]/route.js` (`PUT` routing patch /
  `DELETE`), `[id]/sync/route.js` (pull). `lib/ical.js` — pure `.ics` parser (wraps `ical.js`);
  `lib/ical-map.js` — pure per-event child routing (title → child + cleaned title);
  `lib/subscription-writes.js` — subscription row + `child_map` writes.
- `proxy.js` — fast cookie-presence gate for pages (Next 16 renamed `middleware`).
- See `docs/parent-time-schedules.md` for the scheduling model + preset taxonomy, and
  `docs/ical-subscriptions.md` for feed subscriptions + per-event child routing.

## Data model

`children(id, name, color, sort, archived)` — seeded once with c1=Child 1, c2=Child 2.
`caregivers(id, name, color, sort, archived)` — seeded g1=Dad, g2=Mom. Both are managed
in-app (Settings → Family): add, rename, recolor, and **archive** (`archived` INTEGER, v11).
IDs are stable so events/schedules/seals referencing them never break. **Removal = archive**,
never a hard delete: an archived member is hidden from the add pickers, AI-parse, MCP
`get_context`, and new rotations, but still renders on historical events/reports (name+color
resolved from the full roster). Event *create* requires active members; *edit* is existence-only
(an old event referencing an archived member stays saveable). Archiving the last active child or
parent is refused (409).
`events(id, title, type, child_id, caregiver_id, pickup_caregiver_id, pd, date, time, who, notes,
created_at, updated_at, series_id)`.
`pd` is one of `dropoff | pickup | both`. `date` is `YYYY-MM-DD`, `time` is `HH:MM`.
`caregiver_id` is "Done by" / the drop-off (or sole-leg) parent; `pickup_caregiver_id` (migration v10)
is a distinct pickup-leg parent, persisted only for a trip with `pd='both'` when it differs from
`caregiver_id` (else NULL). A split `both` trip credits each parent one leg in the involvement report
(`lib/report.js`).

Parent-time scheduling (migration v5): `schedules` (repeating-cycle base rotations;
`assignment` is a JSON array of `caregiver_id`, length === `cycle_len`),
`schedule_overrides` (date-range holiday/summer overrides that win over the base),
and `schedule_audit` (append-only, like `event_audit`). The on-duty parent is
**computed** at render time (`lib/schedule.js`), never stored as events. See
`docs/parent-time-schedules.md`.

MCP agent tokens (migration v9): `mcp_tokens(id, token_hash, label, revoked, created_at,
last_used_at)` — capability tokens for the MCP server, same discipline as `share_tokens`
(HMAC-of-token stored, revocation enforced in the lookup SQL, no expiry; revoke is the kill
switch). Minted on `/settings`; `KIN_MCP_TOKEN` env stays a legacy single-token fallback.
Rotating `AUTH_SECRET` invalidates all minted tokens.

iCal subscriptions (migration v12; per-event routing v13): `calendar_subscriptions(id, label, url,
child_id, type, caregiver_id, pd, created_at, last_synced_at, last_status, child_map)`. `child_id` is
**nullable** — NULL means the feed carries more than one kid and each event is routed to a child by
the name in its title (`lib/ical-map.js`). `type` is likewise overloaded: `''` is the **from title**
sentinel (no migration — the column is NOT NULL) meaning the feed pins no activity and each event is
typed from its own title (`feedType` / `routeTitle` in `lib/ical-map.js`, resorting to `other`).
`takesLeg(type)` in `lib/constants.js` is the shared "does this type carry a pd leg" predicate — true
for a trip type or the sentinel. `label`, `type` and `pd` are patchable via `PUT
/api/subscriptions/[id]`, which validates the MERGED row; `url` and `caregiver_id` stay create-time.
`child_map` is a JSON map of the user's one-time
per-group decisions, keyed by normalized title segment — `{ c: child_id, t: title, s: segment,
y: activity type }` (a bare string is the legacy child-only form). `c: ''` marks a key still awaiting
a child; `t`/`y` empty mean "use the default", recomputed per event. Validated in `lib/validate.js`
since SQLite can't FK into JSON. **Activity type is per-group too**: an explicit `y`, else an ordered
keyword guess from the segment, else the subscription's `type`. The guess must never cross the
trip/non-trip line — `normalize()` forces `pd` from the type, so crossing invents or destroys a
transport leg in the report — which takes two rules: hint targets are all trip-typed, **and** guessing
is skipped unless the subscription's own type is trip-typed, or the feed is itself in from-title mode
(`type` `''`) — from-title has no non-trip outcome to land on, since every hint target and the `other`
resort are trip-typed too.
Imported events carry `subscription_id` / `ical_uid` / `ical_key` — nullable plain TEXT, no FK: dedup
tags, not integrity anchors. Sync is **add-only** (dedup on
`subscription_id + ical_uid + date + ical_key`); an unroutable event is *held*, never filed onto a
fallback child. See `docs/ical-subscriptions.md`.

## Conventions & invariants (do not break without asking)

- **Single-user, dependency-light.** Don't add an ORM, auth library, or
  state-management library. Prefer the existing patterns.
- **better-sqlite3 is native.** It's kept out of the Next bundle via
  `serverExternalPackages` in `next.config.mjs`, and compiled in the
  Docker build stage (needs `python3 make g++`). Don't bundle it or swap it for an
  async driver without discussing.
- **Build safety.** All API routes set `export const dynamic = 'force-dynamic'` so
  Next doesn't evaluate the DB at build time. `lib/db.js` guards its seed against
  an undefined count for the same reason. Keep both.
- **Auth on every API route.** Each handler calls `isAuthed()` (via the `guard()`
  helper) and returns 401 if false. The proxy check is a convenience gate, not
  the security boundary — never rely on it alone.
- **Cookies are `secure` in production** → the app must be served over HTTPS.
- **Validation lives in the route handlers.** Both `events` routes validate type,
  pd, date/time format, and child existence. Keep validation server-side.
- Keep `output: 'standalone'` working — it's what the Docker image runs.

## Commands

```bash
npm install                 # native build needs python3 / make / g++
export APP_PASSWORD=dev
export AUTH_SECRET=$(openssl rand -hex 32)
npm run dev                 # http://localhost:3000
npm run build && npm start  # production-style run
docker compose up --build   # full container, reads APP_PASSWORD / AUTH_SECRET from .env
```

## Changing the family

Manage children and parents in-app: **Settings → Family** (add, rename, recolor, archive).
This is the supported path — it goes through the validated, id-stable write layer
(`lib/family-writes.js`). The `lib/db.js` seed (c1=Child 1, c2=Child 2, g1=Dad, g2=Mom) only
runs on a first, empty DB. Don't hard-delete a child/parent by hand (`sqlite3`): events
FK-restrict `child_id`, a caregiver delete cascades their `schedule_overrides` (silently
changing past parent-on-duty and breaking sealed months), and an orphan row crash-loops the
next boot migration — archive instead.

## Working agreement

- Ask before installing dependencies or changing the auth/storage model.
- Make focused changes; explain anything that touches the build, Docker, or auth.
- After changes, confirm `npm run build` still succeeds.
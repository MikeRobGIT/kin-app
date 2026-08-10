# Kin — Record Integrity & Durability Design

**Date:** 2026-06-13
**Status:** Approved direction; pre-implementation design
**Scope:** Turn the self-hosted, single-user Kin SQLite store from "a calendar's
storage" into a **durable, tamper-evident system of record**. This is the first
improvement sprint after deferring the multi-user SaaS (see
`2026-06-12-kin-product-multiuser-design.md`). Implementation is planned separately.

---

## 1. Why

Kin's purpose is a credible, contemporaneous record of one parent's day-to-day
involvement with two kids, intended to hold up in a custody context. A 5-dimension
audit of the live app found that its only **critical** risks are not features — they
are record integrity: the data can be silently altered, and the single SQLite file
has no automated backup. This sprint closes those, plus the cheap integrity hardening
that rides on the same foundation.

**Success criteria.** A fresh clone migrates cleanly to the latest schema; an edit or
delete is provably logged and recoverable; an unclean container kill loses ~nothing;
the "Recorded" timestamp is unambiguous; the schema enforces its own invariants;
`npm run build` and a new `node:test` suite pass.

### Locked decisions

| Decision | Choice |
|---|---|
| Automated backups | **Litestream sidecar → Cloudflare R2** (continuous, point-in-time) |
| Timestamp fix | **Keep UTC in storage; convert to local on display** (`TZ` env, default `America/New_York`) |
| Delete semantics | **Hard-delete + full final snapshot in an append-only audit log** (recoverable) |
| Schema-integrity hardening | **In scope** this sprint (rides on the migration runner) |

---

## 2. Foundation — versioned migration runner (prerequisite)

Replace the ad-hoc "check + `ALTER`" blocks in `lib/db.js` with a `PRAGMA user_version`
runner: an ordered array of migration functions, each wrapped in a transaction, run
once at startup.

- **Migration 1 = baseline.** Create the base tables `IF NOT EXISTS` and add
  `caregiver_id` if missing — folding in today's logic so both a fresh DB and the live
  DB (already has `caregiver_id`, `user_version` still 0) converge to a known state.
  Then set `user_version = 1`.
- **Migrations 2+** are clean, forward-only.
- No library — roughly 40 lines around the existing `better-sqlite3` connection. This
  is the prerequisite that makes every schema change below safe and reproducible.

---

## 3. Schema changes (delivered as migrations)

1. **`events.updated_at`** — `TEXT` NULL default; set on every `PUT`. `created_at`
   stays immutable (it already is — `PUT` deliberately omits it).
2. **`event_audit`** — append-only, no `UPDATE`/`DELETE` in app code:
   `id, event_id, action TEXT CHECK(action IN ('create','update','delete')),
   at TEXT NOT NULL DEFAULT (datetime('now')), snapshot TEXT`. `snapshot` is
   `JSON.stringify` of the full row state. Replaying the log reconstructs every version.
3. **`events` table rebuild** (SQLite can't alter constraints in place):
   - `child_id` → **`ON DELETE RESTRICT`** — deleting a child can no longer cascade-wipe
     their entire history. (Kids are seeded once and effectively never deleted, so
     RESTRICT is the correct policy.)
   - `CHECK` constraints: `pd IN ('dropoff','pickup','both')`; date/time format; field
     length bounds (`title`/`who` ≤ 120, `notes` ≤ 500).
   - **Safeguards:** `PRAGMA foreign_keys = OFF` inside the migration transaction; copy
     into `events_new`; verify row counts match before drop/rename; recreate
     `idx_events_date`; run `PRAGMA integrity_check` after; and ensure a backup exists
     before the deploy that ships this migration.

---

## 4. Audit trail — the tamper-evidence centerpiece

Audit rows are written **in-route, inside the same `db.transaction()` as the mutation**
— not via triggers (explicit, testable, fits single-user). Covers `POST`, `PUT`,
`DELETE`, and the bulk route.

- **create / update** → write a snapshot of the resulting row (`action` `create`/`update`).
- **delete** → **hard-delete the row from `events`, but first write its final snapshot**
  with `action='delete'`. The entry leaves the live table yet remains fully preserved
  and recoverable in the append-only log; the deletion act itself is timestamped.

This is the difference between "a calendar" and "a defensible log": every change to the
record is provable, and nothing vanishes without a trace.

---

## 5. Timestamps & "edited" surfacing

Storage stays UTC (existing rows untouched). Display changes only:

- The report and CSV convert `created_at` (and `updated_at`) to local time via a **`TZ`
  env var (default `America/New_York`)** and label the column **"Recorded (local)"**, so
  a 7:30 pm-local entry no longer shows the next calendar day.
- When `updated_at != created_at`, show an **"edited" marker** with the edit time, so an
  entry materially changed after the fact never masquerades as original. (Fixes the
  report's current affirmative-but-unbackable "recorded on X" claim.)

---

## 6. Validation hardening (shared library)

A single `lib/validate.js` imported by the events `POST`/`PUT`/bulk routes and the parse
route, eliminating the three copies that currently drift.

- **Real calendar-date validation**: parse `Y-M-D`, reconstruct a `Date`, require it
  round-trips; require `00–23` hours and `00–59` minutes. Rejects `2026-02-30`, `99:99`,
  and the `2026-13-01`→2027 backfill rollover (`expandDates` bounds get the same check).
- **Length caps**: `title`/`who` ≤ 120, `notes` ≤ 500 — matching what the parse route
  already promises but the persisting routes never enforced.
- **GET range**: validate `from`/`to` with the same real-date check; `400` on malformed
  rather than silently returning a wrong/empty set.

---

## 7. Faithful export

Authed **`GET /api/export`** → a complete JSON dump: all `events` columns, `children`,
`caregivers`, **and `event_audit`**, plus `exported_at` and `schema_version`. This is the
defensible, complete handoff artifact for counsel; the report CSV remains the
human-readable summary. A consistent `.db` snapshot is covered by Litestream (§9).

---

## 8. Durability hardening

- **Clean shutdown**: register `SIGTERM`/`SIGINT` handlers in `lib/db.js` →
  `wal_checkpoint(TRUNCATE)` then `db.close()`, so a redeploy doesn't rely on crash
  recovery and the main file isn't left tiny.
- **Integrity check**: `PRAGMA quick_check` on startup; log/alert on failure so silent
  corruption surfaces early instead of when the file won't open.
- **Health endpoint**: new `app/api/health/route.js` (`force-dynamic`, runs `SELECT 1`);
  repoint the Docker healthcheck at it. Today `/login` reports healthy even if the DB is
  corrupt or unwritable.
- **README fix**: replace the dangerous "copy `tracker.db`" advice with
  `sqlite3 tracker.db ".backup ..."` (online, WAL-safe).

---

## 9. Backups — Litestream → Cloudflare R2

A **Litestream sidecar** in `docker-compose.yml` sharing the `tracker_data` volume, with
`litestream.yml` replicating `tracker.db` to a Cloudflare **R2** bucket (credentials via
env). Gives continuous replication with point-in-time recovery and near-zero RPO.

- **Open item (verify at plan time):** Litestream manages checkpointing; reconcile this
  with the app-side WAL settings in §8 per current Litestream docs so the two don't
  fight. Confirm against the live Litestream documentation during planning.
- **Restore drill documented** in the README — a backup nobody has restored isn't a
  backup. Include the exact `litestream restore` command and a periodic restore-test note.

---

## 10. Tests (safety net for the schema surgery)

A minimal **`node:test`** suite (built into Node — no new dependency):

- `validate()` — valid + invalid dates/times, length caps.
- The migration runner against a temp DB (fresh → latest; idempotent re-run).
- A round-trip: `POST` → `PUT` → `DELETE` asserting the correct `event_audit` rows appear
  and a deleted row's snapshot is preserved.

CI wiring (a GitHub Actions job running `npm ci`, the native build, `npm run build`, and
the tests) is a recommended follow-up, not in this sprint.

---

## 11. Sequencing

`§2 migration runner` → `§3 schema` → `§6 validation` → `§4 audit writes` →
`§5 timestamps/edited` → `§7 export` → `§8 durability` → `§10 tests` → `§9 Litestream`.
Migration runner first; backups infra last.

## 12. Not in scope (deferred to their own sprints)

Login rate-limiting · security headers (HSTS/frame-ancestors/nosniff) · revocable
sessions · authed-API `no-store` · calendar full-history fetch scoping · out-of-grid
event rendering · mobile tap targets / sticky modal · month-view caregiver attribution ·
PWA install. These came out of the same audit and are tracked for follow-up.

**Constraint note:** Litestream is a sidecar *container*, not an npm dependency — no
change to the app's dependency-light constraint or to `better-sqlite3`. No ORM, auth
library, or state library is introduced.

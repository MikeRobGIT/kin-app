# Family settings — configure children & parents (design)

2026-07-18. Approved via brainstorming; decisions confirmed with the owner.

## Problem

The two children are seeded once in `lib/db.js` and are not editable in-app (CLAUDE.md says
"edit `lib/db.js` before first launch, or `sqlite3` the DB"). Parents can be renamed/recolored,
but only inside the parent-time manager modal, and neither table supports adding or removing
members. Real families change: a third child arrives, a grandparent starts doing pickups, a
name is misspelled. Goal: manage the family roster (add / rename / recolor / archive) from
Settings, without ever compromising the historical custody record.

## Decisions (confirmed)

1. **Removal = archive, never delete.** Hidden from pickers and new records; ALL history
   (events, reports, sealed months, share links) stays intact; reversible.
2. **One Family section on `/settings`** managing both children and parents. The duplicate
   Parents editor inside ScheduleManager is removed.
3. **No audit table** — matches the existing caregiver-rename precedent; archive is
   non-destructive, and an audit migration can be added later if ever needed.

## Why archive (not delete) — grounded in the touchpoint sweep

- `events.child_id` is `ON DELETE RESTRICT`; `caregiver_id`/`pickup_caregiver_id` are
  `NO ACTION` → hard deletes 500 or force history rewrites.
- `schedule_overrides.caregiver_id` is `ON DELETE CASCADE` → deleting a parent silently wipes
  their holiday/summer overrides, retroactively changing computed parent-on-duty for PAST
  dates → **already-sealed months verify as TAMPERED** (false alarm on the app's core
  integrity feature).
- `schedules.assignment` is JSON (no FK) → a deleted parent leaves a ghost id that dangles in
  rotations and silently corrupts overnight percentages.
- The seed guard re-inserts the default family whenever a table is empty → hard-deleting the
  last member resurrects Child 1/Child 2/Dad/Mom on next boot. Archive sidesteps all of it.

## Data model

Migration **v11** (append-only, boot-safe additive columns):

```sql
ALTER TABLE children  ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE caregivers ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
```

Ids stay stable forever. Nothing is ever deleted. No other schema change.

## Semantics

- **Active** (`archived = 0`) members appear in: the add-event child/parent pickers, the
  calendar legend, the AI-parse prompt roster, MCP `get_context`, and the new-rotation
  selects.
- **Archived** members are hidden from all of the above, but every historical
  event/schedule/override/report/seal/share renders their name + color normally — render
  lookups keep using the FULL list.
- **Server enforcement** (validation lives server-side, per house rules):
  - *Create* event → `child_id`, `caregiver_id`, `pickup_caregiver_id` must be active.
  - *Edit* existing event → existence check only (archived allowed), so old records never
    400-trap.
  - Schedule and override writes → parents must be active.
  - Archiving the **last active** child or parent → 409.
  - Archiving a parent still referenced by an active rotation or future override is ALLOWED
    (custody usually ends before the schedule is rewritten); `parentOnDate` keeps resolving
    them and the calendar/report keep attributing those days until the rotation is edited.
    The Family UI shows a hint when this is the case.
  - Unarchive at any time.
  - Duplicate **active** name (same table, case-insensitive) → 400 "Name already in use"
    (protects the AI-parse name→id matching from misfiling events).

## API

| Route | Methods | Notes |
|---|---|---|
| `app/api/children/route.js` (new) | GET all (incl. archived), POST create `{name, color}` | |
| `app/api/children/[id]/route.js` (new) | PUT `{name?, color?, archived?}` | |
| `app/api/caregivers/route.js` (new) | GET all, POST create | |
| `app/api/caregivers/[id]/route.js` (existing) | PUT gains `archived` | keeps rename/recolor |

- Id minting: next numeric suffix per table (`c3`, `g3`, …) computed over ALL rows including
  archived; `sort` = max+1.
- Color required (`#rrggbb`); the UI auto-suggests the next palette color.
- Writes go through a transactional `lib/family-writes.js`; field validation in
  `lib/validate.js`; every route uses `guard()` + `export const dynamic = 'force-dynamic'`.

## UI

**New "Family" section on `/settings`** (above Agent access): a Children list and a Parents
list. Each active row = color swatch (color input) + name input + Save + Archive. Archived
rows grouped under a collapsed "Archived (n)" with Unarchive. One Add row per list (name +
auto-suggested color). Wide content follows the `.table-scroll` / 375px house rules.

**Removed:** the Parents section inside `components/ScheduleManager.js` (management moves to
Family; the modal keeps rotations/overrides only).

**Collateral correctness fixes (shipped with this feature):**

- `components/Calendar.js`: pickers list active members only, but when editing an event that
  references an archived member, that member is injected as an extra `<select>` option
  (restore-selection rule) so the form isn't invalid. The hardcoded `'c1'` fallbacks
  (`EMPTY`, sticky-default restore, backfill base) become "first active child".
- `components/ScheduleManager.js`: rotation A/B selects list active parents; opening a
  schedule whose assignment references parents not representable in the A/B editor (archived,
  or a 3rd distinct id) shows a notice and refuses a lossy save — today it silently collapses
  them to parent B and rewrites the rotation.
- `app/api/parse/route.js`: prompt roster = active only; the "I/me" mapping uses the first
  *active* parent by sort.
- MCP: `lib/mcp-tools.js getContext` returns active only; the hardcoded `c1 / c2` and
  `g1 / g2` literals in `lib/mcp-server.js` eventShape descriptions become generic
  ("use ids from get_context").

## Error handling

- All new routes: 401 unauthed, 400 validation (specific messages), 404 unknown id,
  409 last-active-member, 500 only on genuine faults.
- The Settings UI surfaces server error messages inline (alert-style, matching the token
  manager) and refreshes lists after every mutation.
- Calendar/schedule stale-form saves referencing a just-archived member fail server-side with
  the existing "Unknown …"-style messages plus the new active-only checks; the UI already
  re-fetches on modal open.

## Testing

- Migration v11: column present, default 0, `user_version` = 11, no FK violations.
- `family-writes`: id minting (incl. gaps/archived), dup-active-name 400, last-active 409,
  archive → unarchive round-trip, rename/recolor.
- `validate`: event create blocks archived member; event edit allows; schedule/override
  writes block archived parents.
- MCP: `get_context` active-only.
- Existing roster-pinned tests (`mcp-tools.test.js` exact `['c1','c2']` deepEqual,
  `event-writes.test.js` buildExport length===2) keep passing because test DBs are isolated;
  new tests use their own temp DBs.
- Browser-verify (dev :3001, minted cookie): Family CRUD desktop + 375px; add a child → it
  appears in the calendar picker; archive it → gone from picker, old events still render
  name/color, editing an old event still saves; parent archive reflected in ScheduleManager.

## Docs

- CLAUDE.md: rewrite "Changing the kids" (now done in-app on /settings; `lib/db.js` seed is
  first-boot only) and the data-model lines (archived column).
- `docs/parent-time-schedules.md`: drop the "adding/removing caregivers is a non-goal" note.

## Non-goals

- No hard delete anywhere (archive only).
- No audit table for family changes.
- Rotations stay two-parent pairs; a 3rd+ parent participates via overrides or separate
  seasonal schedules, not N-ary rotation editing.
- No reassignment of historical events between members.

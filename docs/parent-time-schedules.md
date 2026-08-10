# Parent-time scheduling

How Kin models and displays which parent has the kids over time. This is the
research record behind the feature plus the implementation reference.

> Informational only — not legal advice. Custody rules are jurisdiction-specific.

## The model: a repeating cycle + overrides

Every common parenting-time schedule reduces to a **repeating N-day cycle of
parent assignments anchored to a date**. The on-duty parent for date `D` is:

```
idx    = ((daysSince(anchor, D) % cycleLen) + cycleLen) % cycleLen
parent = assignment[idx]
```

This is O(1), needs no materialized event rows, is editable retroactively, and
expresses every standard schedule below plus arbitrary custom ones. Holidays and
summer are **overrides** layered on top — date ranges that win over the base.

`lib/schedule.js` is the pure engine (`parentOnDate`, `resolvePreset`,
`splitPercent`, `detectCycle`, …). It is DB-free and runs identically on the
server, in the client bundle, and in tests.

### Resolution precedence (`parentOnDate`)

1. **Override** covering `D` wins. If several overlap, the latest `created_at`.
2. Else the **base schedule** active for `D` (`starts_on…ends_on`, NULL = open).
   A fully-bounded segment (e.g. a summer block) beats an open-ended base;
   tiebreak latest `starts_on`, then latest `created_at`.
3. Else no overlay that day.

## Preset taxonomy

Patterns are Monday-first (cycle day 0 = Monday). `A` = first chosen parent,
`B` = second. The manager maps A/B onto two `caregiver_id`s and previews the
cycle so the user confirms anchor/weekend alignment. Splits are asserted in
`test/schedule.test.js`.

| key | label | cycle | pattern (Mon→…) | split A/B | typical use |
|---|---|---|---|---|---|
| `week_on_off` | Week on / week off | 14 | `AAAAAAA BBBBBBB` | 50/50 | simple 50/50, school-age, close proximity |
| `two_two_three` | 2-2-3 | 14 | `AABBAAA BBAABBB` | 50/50 | frequent contact; younger kids |
| `two_two_five_five` | 2-2-5-5 | 14 | `AABBAAA AABBBBB` | 50/50 | fixed weekdays + alternating weekends |
| `three_four_four_three` | 3-4-4-3 | 14 | `AAABBBB AAAABBB` | 50/50 | balanced blocks, fewer transitions |
| `alt_two` | Alternating every 2 days | 4 | `AABB` | 50/50 | infants/toddlers (rarely primary) |
| `every_other_weekend` | Every other weekend | 14 | `AAAABBB AAAAAAA` | ~79/21 | one primary parent + alt-weekend parent |
| `custom` | Custom | 1–28 | user-defined | computed | anything else |

The Georgia "standard" arrangement (one parent weekdays, the other every other
weekend, with holidays and summer handled separately) is `every_other_weekend`
as the base plus holiday/summer **overrides** (and an optional summer **segment**,
e.g. a date-bounded `week_on_off`).

## Data model (migration v5)

Three tables; see `lib/migrate.js`. Parents reuse the existing `caregivers`
table (managed in-app via Settings → Family — add/rename/recolor/archive; IDs stay
stable so schedules never break). Rotations and overrides reference **active** parents
only; an archived parent left in an existing rotation still resolves at read time, but the
schedule can't be re-saved until it's rewritten with active parents (the manager enforces this).

- `schedules(id, label, preset_key, cycle_len, assignment, anchor_date, starts_on, ends_on, created_at, updated_at)`
  — `assignment` is a JSON array of `caregiver_id`, length === `cycle_len`.
- `schedule_overrides(id, caregiver_id, date_from, date_to, label, created_at, updated_at)`.
- `schedule_audit(id, kind, ref_id, action, at, snapshot)` — append-only, mirrors `event_audit`.

`caregiver_id` membership inside `assignment` is enforced in `lib/validate.js`
(SQLite can't FK into JSON).

## API

- `GET /api/schedules` → `{ schedules, overrides }`; `POST` create schedule.
- `PUT|DELETE /api/schedules/[id]`.
- `POST /api/overrides`; `PUT|DELETE /api/overrides/[id]`.
- `GET|POST /api/caregivers` + `PUT /api/caregivers/[id]` — add / rename / recolor / archive a
  parent (Settings → Family).

All `force-dynamic` and `isAuthed`-gated; writes go through transactional helpers
in `lib/schedule-writes.js` (schedules/overrides) and `lib/family-writes.js` (parents).

## Display

Computed at render time in `components/Calendar.js`, never as events:
- **Week** — a thin parent-color band under each day header; `⇄` marks handoff days.
- **Day** — a "{Parent} has the kids" banner (with the override label, if any).
- **Month** — a soft background tint + corner initial per cell.

A toggle (persisted to `localStorage`) hides the overlay; parents appear in the
legend. Management lives in `components/ScheduleManager.js`.

## Out of scope (v1)

Per-child schedules; handoff *times* (whole-day model only); a prebuilt holiday
template library; rotations spanning more than two parents (a third parent participates
via overrides or a separate seasonal schedule). A natural follow-up is feeding
custody-day % into the involvement report (`components/Report.js`).

## Sources

Custody-schedule taxonomy and modeling synthesized from family-law and
custody-software references (Custody X Change, OurFamilyWizard, TalkingParents)
and general Georgia parenting-plan guidance (O.C.G.A. Title 19, Ch. 9; Georgia
requires a written parenting plan covering the physical-custody schedule,
holidays, and transportation). Verify specifics with a Georgia family-law
attorney before relying on them.

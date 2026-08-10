# Editable feed settings + "From title" activity

## Context

A saved iCal subscription is created once and never edited. `PUT /api/subscriptions/[id]` accepts
only `child_id` and `child_map` — `label`, `url`, `type`, `caregiver_id` and `pd` are all
create-time. Two consequences, both live in production today:

1. A feed added without a label reads `—` in the Settings table forever.
2. A feed's activity type is fixed. The production feed carries swim classes *and* day camp under
   `type: 'other'`.

The child dimension already went per-event in v13 (`child_id NULL` → route each occurrence by the
name in its title). The activity dimension got a per-*group* guess in the follow-up, but only as a
fallback *underneath* a mandatory feed-level type, which is why the row renders `Other (default)`.

There is no way to say "this feed has no single activity — read it from each title."

**The conversion trap.** With `type` create-time-only, the only route from the existing feed to a new
type is delete + re-add. That mints a new subscription id and clears `subscription_id` on the 11
already-imported events, so the next sync matches nothing and re-imports all of them — the exact
duplicate incident that started this work. Editing in place is therefore not a convenience; it is the
only non-destructive path.

**No migration.** `type` is `TEXT NOT NULL DEFAULT 'sport'`. The empty string satisfies NOT NULL and
is not a `TYPE_KEYS` member, so it is available as a sentinel. Schema stays at v13.

---

## Design

### 1. `type = ''` — "from title"

The activity mirror of `child_id NULL`: the feed declares no activity, and each event's type is
resolved from its own title.

### 2. Resolution order

`explicit per-group y` → keyword guess from the leading segment → `other`.

The property that makes this safe: **every outcome in from-title mode is trip-typed.** Every entry in
`HINTS` targets a trip type, and the `other` resort is `trip: true`. So `pd` is always meaningful and
a guess can neither fabricate nor destroy a transport leg in the involvement report.

That failure is the reason the existing guess is gated on `isTrip(fallbackType)`: on a non-trip feed,
`pd` is NULL, the sync route writes `sub.pd || 'dropoff'`, `normalize()` keeps it because the guessed
type *is* a trip, and the event arrives with a fabricated drop-off leg credited to the feed's parent.
From-title mode does not reopen that hole — it has no non-trip resort to fall through to.

A per-group `y` override may still select a non-trip type from the Caregiving optgroup. That is an
explicit user choice, and `normalize()` already forces `pd` to NULL for a non-trip type. Unchanged.

### 3. `lib/ical-map.js` — two expressions

```js
const guessed = guess && !named && (fallbackType === '' || isTrip(fallbackType)) ? guessType(seg) : null;
const type = entry.type || guessed || fallbackType || 'other';
```

A truthy `fallbackType` short-circuits both, so every existing feed behaves bit-identically. Only the
`''` sentinel takes the new branch.

### 4. Sync route — the pinned path resolves `''` too

Today the pinned branch does `type = sub.type` and `routeTitle` never runs. With the sentinel that
writes `type: ''` onto the row, `validateEvent` returns `Invalid type`, the route returns 400, and
**the entire pull aborts — every time, permanently**, with a `last_status` naming the wrong cause.

This is reachable without any new UI: the existing PUT already switches a feed from per-event to
pinned. So the pinned path must resolve the sentinel — as a named export of `lib/ical-map.js` rather
than an expression inline in the route, so it is unit-testable without HTTP (the same reason the dedup
lookups live in `lib/subscription-writes.js`):

```js
// lib/ical-map.js
export const feedType = (subType, title) =>
  subType || (title && guessType(nameSegment(title))) || 'other';
```

Guess from `nameSegment`, not the whole title — the same venue/coach hardening the per-event path
uses. `"Practice — Riverside Gymnastics Center"` must stay `other`, not become Gymnastics off the
venue name.

`ical_key` stays NULL on the pinned path. Dedup semantics are untouched: `dedupPinnedStmt` ignores the
key, and `dedupRoutedStmt`'s `ical_key IS ? OR ical_key IS NULL` half still covers a
pinned → per-event switch.

### 5. `pd` and the Leg control

`isTrip(type) || type === ''` in `createSubscription` and in the add form's `trip` const, so the Leg
select renders and `pd` is stored. Correct because every from-title outcome is trip-typed.

### 6. Patchable fields

`PUT /api/subscriptions/[id]` gains `label`, `type` and `pd`. Absent means unchanged, matching the
handler's existing merge for `child_id`/`child_map`. `url` stays create-time — a changed URL means
different UIDs, which is the duplicate failure by another route.

`validateSubscriptionPatch` validates the **merged row**, not just the supplied fields (the rule from
PR #27, where unarchive-without-name bypassed name-uniqueness):

- `label` — existing `LIMITS.label` length check.
- `type` — a `TYPE_KEYS` member or `''`.
- `pd` — coherent with the *resulting* type: NULL when the merged type is non-trip, defaulting to
  `dropoff` when the merged type is trip-typed or `''`.

Without the merged-row check, switching a feed from Sports to Bedtime leaves a stale `pd` that
`normalize()` and `lib/report.js` disagree about.

`updateSubscription`'s UPDATE statement gains the three columns.

### 7. UI — editor below the table, not inside it

The table stays read-only. Each row's action group gains **Edit**, which reveals an editor strip
directly below the table, reusing the `.sub-rule` flex CSS already verified at 375px.

Inputs in `<td>`s were rejected deliberately. `Settings.js:437` already records the reasoning for the
routing-rule controls — a text input plus two 16px touch-sized selects widen the table and bury the
controls behind sideways panning on a phone — and `kin.md` records two separate regressions of exactly
this class that only the narrow render caught.

Editor contents: label input, activity select (with a `— from title (match each title) —` option),
leg select when the selected type is trip-typed or `''`, then Save / Cancel. One row open at a time.
Save is `dirty`-gated and disabled while busy, matching `NameRule`.

The add form's Activity select gains the same `— from title —` option.

Row display: `From title` when `type === ''`, and the `(default)` suffix is dropped for that case —
in from-title mode nothing is a default, so the suffix would misdescribe it. A pinned feed with a real
type is unchanged.

`Settings.js`'s `defaultType` expression must change in lockstep with §3 — its comment claims it
"mirrors routeTitle exactly", and a silent divergence would show the user a different guess than the
one that gets imported.

---

## Out of scope

- **Per-group activity overrides for a pinned feed.** The routing-rule list only exists for
  per-event feeds. A pinned from-title feed gets the guess with no per-group correction UI; a wrong
  guess is fixed by editing the event on the calendar. Safe because every from-title outcome is
  trip-typed, so a wrong guess is cosmetic and cannot alter the involvement report.
- **Editing `url` or `caregiver_id`.**
- **Retro-typing already-imported events.** Sync is add-only and `lib/seal.js` seals `type`. A rule
  or feed change applies to future imports only; existing events keep the type they were filed under
  and stay editable in the calendar.

---

## Testing

| File | Covers |
|---|---|
| `test/ical-map.test.js` | `fallbackType: ''` enables the guess; resort is `other` when nothing matches; an explicit `y` still wins; a truthy `fallbackType` is unchanged (regression guard for every existing feed). |
| `test/validate.test.js` | `''` accepted as a subscription type on create and patch; a non-key string still rejected; merged-row `pd` coherence — trip→non-trip clears `pd`, non-trip→trip sets it, absent fields do not reset it. |
| `test/subscription-writes.test.js` | `updateSubscription` persists label/type/pd; absent fields unchanged. |
| `test/ical-map.test.js` | `feedType` (§4): a real `subType` passes through untouched; `''` + a titled occurrence guesses from the segment; `''` + a title-less occurrence resorts to `other`; the venue false-positive stays `other`. |

**Invariant worth asserting once:** every `HINTS` target is trip-typed *and* the `other` resort is
trip-typed. That single assertion is what guarantees from-title mode cannot alter a transport leg, and
it will fail loudly if someone later adds a caregiving hint.

## Verification

1. `npm test` **unpiped**, read the `# pass` / `# fail` counts (kin.md process rule).
2. `npm run build`.
3. End-to-end on the real feed from a clean DB: add as per-event + from-title, sync, confirm the
   groups type correctly; convert an existing `other` feed to from-title via Edit and confirm the
   subscription id is unchanged and a re-sync adds **0**.
4. Browser-verify at 375px: the table must not widen (`scrollWidth <= clientWidth` on the page), the
   editor strip wraps, 0 console messages.

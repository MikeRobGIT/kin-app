# Editable feed settings + "From title" activity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a saved iCal subscription's label and activity be edited in place, and add a "from title" activity mode that types each imported event from its own title instead of pinning one type to the whole feed.

**Architecture:** `calendar_subscriptions.type = ''` is a sentinel meaning "no feed-level activity" — the activity mirror of `child_id NULL` = "no pinned child". The column is `TEXT NOT NULL DEFAULT 'sport'`, so `''` satisfies NOT NULL and **no migration is needed**; the schema stays at v13. Resolution order per event is `explicit per-group y` → keyword guess from the title's leading segment → `other`. `PUT /api/subscriptions/[id]` grows `label`/`type`/`pd`, validated as a merged row.

**Tech Stack:** Next.js 16 App Router, better-sqlite3 (synchronous, native), plain CSS, `node:test` + `node:assert/strict`.

## Global Constraints

- **Node 20 required** — `nvm use 20` before any npm/node command. better-sqlite3's native addon will not build on the default Node 25.
- **Worktree:** `/Users/crisis/_workspace/transport-tracker.wt/feat-ical-feed-edit`, branch `feat/ical-feed-edit`. All paths below are relative to it.
- **No migration.** Do not add a function to `lib/migrate.js`. If you believe you need one, stop and re-read the spec.
- **Never pipe the test gate.** Run `npm test` unpiped and read the explicit `# pass` / `# fail` counts before any commit. A pipeline's exit status is the last command's, so `npm test | tail && git commit` commits on a red suite.
- **No `Co-Authored-By`** in any commit message.
- **Every from-title outcome must stay trip-typed.** Every `HINTS` target plus the `other` resort. This is the property that stops the mode from fabricating or destroying a transport leg in `lib/report.js`. Task 1 asserts it.
- `url` and `caregiver_id` stay create-time. Do not make them patchable.
- Run tests with `TZ=America/New_York npm test` to match the existing suite's assumptions.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/constants.js` | `takesLeg(type)` — shared "does this type carry a leg" predicate | 1 |
| `lib/ical-map.js` | `feedType()` + the two `routeTitle` expressions that resolve `''` | 1 |
| `app/api/subscriptions/[id]/sync/route.js` | pinned path calls `feedType` | 1 |
| `lib/validate.js` | `''` accepted on create; patch validates the merged row | 2 |
| `lib/subscription-writes.js` | `createSubscription` leg for `''`; `updateSubscription` persists label/type/pd | 3 |
| `app/api/subscriptions/[id]/route.js` | PUT merges the three new fields before validating | 3 |
| `components/Settings.js` | add-form option, row display, `FeedEdit` strip, `defaultType` lockstep | 4 |
| `app/globals.css` | `.sub-edit` | 4 |
| `docs/ical-subscriptions.md`, `CLAUDE.md` | document the sentinel and what is editable | 5 |

---

### Task 1: Resolve the `''` sentinel at sync time

The whole feature is inert without this, and getting it wrong bricks a feed permanently.

**Files:**
- Modify: `lib/constants.js` (append after `isTrip`)
- Modify: `lib/ical-map.js:163-164` (the two expressions in `routeTitle`), plus a new export
- Modify: `app/api/subscriptions/[id]/sync/route.js:16` (import) and `:101` (`let type = ...`)
- Test: `test/ical-map.test.js`

**Interfaces:**
- Consumes: `guessType`, `nameSegment`, `isTrip`, `TYPES`, `HINTS` (all existing).
- Produces:
  - `takesLeg(type: string) => boolean` from `lib/constants.js` — true for a trip type **or** the `''` sentinel. Tasks 2, 3, 4 all use it.
  - `feedType(subType: string, title: string|null|undefined) => string` from `lib/ical-map.js` — always returns a live `TYPES` key, never `''`.

- [ ] **Step 1: Write the failing tests**

Append to `test/ical-map.test.js`:

```js
test('feedType passes a real subscription type straight through', () => {
  // Regression guard for every subscription that exists today: a feed with its own type must not
  // acquire a guess. The truthy short-circuit is the whole mechanism.
  assert.equal(feedType('sport', 'Minnows (3yr-5yr)'), 'sport');
  assert.equal(feedType('meal', 'Swim Lesson - Pool A'), 'meal');
  assert.equal(feedType('other', 'Summer Day Camp'), 'other');
});

test("feedType resolves the '' sentinel from the title's leading segment", () => {
  assert.equal(feedType('', 'Swim Lesson - WCAC Sat 10:30 am'), 'sport');
  assert.equal(feedType('', 'Summer Day Camp'), 'camp');
  assert.equal(feedType('', 'Minnows (3yr-5yr)'), 'sport');
});

test("feedType resorts to `other` when the sentinel can't be resolved", () => {
  // The segment, never the whole title: the venue names a sport the event is not.
  assert.equal(feedType('', 'Practice - Riverside Gymnastics Center'), 'other');
  assert.equal(feedType('', 'Chess Club - Room 4'), 'other');
  // A SUMMARY-less occurrence has no title to read.
  assert.equal(feedType('', ''), 'other');
  assert.equal(feedType('', null), 'other');
  assert.equal(feedType('', undefined), 'other');
});

test('routeTitle guesses on a from-title feed and resorts to `other`', () => {
  const swim = { 'minnows 3yr 5yr': { c: 'c1', s: 'Minnows (3yr-5yr)' } };
  assert.equal(routeTitle('Minnows (3yr-5yr) - WCAC', kids, swim, '').type, 'sport');
  const chess = { 'chess club': { c: 'c1', s: 'Chess Club' } };
  assert.equal(routeTitle('Chess Club - Room 4', kids, chess, '').type, 'other');
});

test('an explicit per-group type still wins on a from-title feed', () => {
  const rules = { 'minnows 3yr 5yr': { c: 'c1', s: 'Minnows (3yr-5yr)', y: 'camp' } };
  assert.equal(routeTitle('Minnows (3yr-5yr) - WCAC', kids, rules, '').type, 'camp');
});

test('a feed with its own type is untouched by the sentinel branch', () => {
  // A non-trip feed still gets NO guess — guessing there would flip trip-ness and fabricate a leg.
  const chess = { 'chess club': { c: 'c1' } };
  assert.equal(routeTitle('Chess Club - Room 4', kids, chess, 'meal').type, 'meal');
  const swim = { 'minnows 3yr 5yr': { c: 'c1' } };
  assert.equal(routeTitle('Minnows (3yr-5yr) - WCAC', kids, swim, 'sport').type, 'sport');
});
```

Extend the **existing** `every hint targets a live, TRIP-typed key and is its own normKey` test at `test/ical-map.test.js:44` by adding one assertion after its `for` loop:

```js
  // The `other` resort closes the same loop: from-title mode has NO non-trip outcome to land on,
  // which is what lets it exist without a per-group override on every feed shape.
  assert.equal(TYPES.other.trip, true, 'the `other` resort must be trip-typed');
```

Add `feedType` to the import list at `test/ical-map.test.js:3-5`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
nvm use 20 && TZ=America/New_York node --test test/ical-map.test.js
```

Expected: FAIL — `feedType is not a function`, and the `routeTitle` sentinel tests report `type: ''` where `'sport'`/`'other'` is expected.

- [ ] **Step 3: Add `takesLeg` to `lib/constants.js`**

Append after the existing `isTrip` export:

```js
// '' is the subscription "from title" sentinel (calendar_subscriptions.type): the feed declares no
// activity and each imported event is typed from its own title. Every outcome of that resolution is
// trip-typed — every HINTS target in lib/ical-map.js, plus the `other` resort — so such a feed
// carries a leg exactly like a real trip type does. Used by the subscription validator, writes and
// Settings UI so the three can't drift.
export const takesLeg = (type) => type === '' || isTrip(type);
```

- [ ] **Step 4: Add `feedType` to `lib/ical-map.js`**

Insert immediately after `guessType`:

```js
// The activity type for ONE occurrence of a feed, used on the PINNED path where routeTitle never
// runs. `subType` is the subscription's own type; '' is the "from title" sentinel.
//
// This must exist even though the activity picker looks orthogonal to child pinning: the existing
// PUT switches a feed from per-event to pinned, and a from-title feed switched that way would write
// type '' onto every row → validateEventFields 'Invalid type' → the sync route 400s and aborts the
// ENTIRE pull, every time, permanently, with a last_status naming the wrong cause.
//
// Guess from the leading SEGMENT, never the whole title — the same venue/coach hardening routeTitle
// uses. "Practice - Riverside Gymnastics Center" must stay `other`, not become Gymnastics off the
// venue. Always returns a live TYPES key, never '' — the caller writes it straight onto an event row.
export const feedType = (subType, title) =>
  subType || (title && guessType(nameSegment(title))) || 'other';
```

- [ ] **Step 5: Update the two `routeTitle` expressions**

At `lib/ical-map.js:163-164`, replace:

```js
  const guessed = guess && !named && isTrip(fallbackType) ? guessType(seg) : null;
  const type = entry.type || guessed || fallbackType;
```

with:

```js
  const guessed =
    guess && !named && (fallbackType === '' || isTrip(fallbackType)) ? guessType(seg) : null;
  const type = entry.type || guessed || fallbackType || 'other';
```

Then extend the block comment above them (which currently explains the trip-typed gate) with:

```
  //  - OR the feed is in "from title" mode (fallbackType === ''), where guessing IS the point and
  //    there is no non-trip outcome to flip to: every hint target and the `other` resort are
  //    trip-typed, so pd stays coherent. A truthy fallbackType short-circuits both expressions, so
  //    every feed that has its own type behaves bit-identically to before.
```

- [ ] **Step 6: Wire the sync route's pinned path**

In `app/api/subscriptions/[id]/sync/route.js`, change the import at line 16:

```js
import { parseChildMap, routeTitle, feedType } from '@/lib/ical-map';
```

and replace `let type = sub.type;` (line 101) with:

```js
    let type = feedType(sub.type, o.title);
```

Leave the per-event branch alone — it already overwrites `type` with `r.type`. Do **not** touch `ical_key` on the pinned path; it stays NULL, which is what keeps `dedupPinnedStmt` and the pinned↔per-event switch working.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
TZ=America/New_York node --test test/ical-map.test.js
```

Expected: PASS, no failures.

- [ ] **Step 8: Run the full suite unpiped**

```bash
TZ=America/New_York npm test
```

Read the `# pass` / `# fail` lines. Expected: `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add lib/constants.js lib/ical-map.js "app/api/subscriptions/[id]/sync/route.js" test/ical-map.test.js
git commit -m "feat(ical): resolve a '' feed type from each event title"
```

---

### Task 2: Accept `''` on create, and validate the patch as a merged row

**Files:**
- Modify: `lib/validate.js:131-147` (`validateSubscription`), `:195-202` (`validateSubscriptionPatch`), `:1` (import)
- Test: `test/validate.test.js`

**Interfaces:**
- Consumes: `takesLeg` from Task 1.
- Produces: `validateSubscriptionPatch(mergedRow, db)` now **requires a complete row** — `label`, `type` and `pd` must be present, already merged over the stored row. Task 3's PUT handler is responsible for that merge.

> **Expected breakage:** the existing test `validateSubscriptionPatch guards both the pinned child and the rule map` (`test/validate.test.js:171`) passes partial objects like `{ child_id: 'c2' }`. Those 4 assertions will now return `'Invalid type'`. That is correct — a partial object is no longer a valid input — so **update the test**, do not weaken the validator. Step 1 includes the rewritten test.

- [ ] **Step 1: Write the failing tests**

Replace the whole existing test at `test/validate.test.js:171-179` with:

```js
test('validateSubscriptionPatch guards both the pinned child and the rule map', () => {
  // The patch validator sees a MERGED row (the route merges the body over the stored row before
  // calling), so every field is present. A partial object is a caller bug, and is rejected.
  const base = { child_id: null, child_map: {}, label: 'Swim', type: 'sport', pd: 'dropoff' };
  assert.equal(validateSubscriptionPatch(base, subDb), null);
  assert.equal(validateSubscriptionPatch({ ...base, child_id: 'c2' }, subDb), null);
  assert.equal(validateSubscriptionPatch({ ...base, child_id: 'cX' }, subDb), 'Unknown or archived child');
  // The PINNED child stays active-gated — assigning a feed to a retired kid is a fresh assertion.
  assert.equal(validateSubscriptionPatch({ ...base, child_id: 'c9' }, subDb), 'Unknown or archived child');
  assert.equal(validateSubscriptionPatch({ ...base, child_map: { k: 'cX' } }, subDb), 'Unknown child');
  assert.equal(validateSubscriptionPatch(null, subDb), 'Invalid body');
});

test('validateSubscriptionPatch validates the MERGED row, not just the supplied fields', () => {
  // The PR #27 rule: check the state the row will END UP in. A trip → caregiving switch that left a
  // stale pd behind would have normalize() and lib/report.js disagree about the transport leg.
  const base = { child_id: null, child_map: {}, label: 'Swim', type: 'sport', pd: 'dropoff' };
  assert.equal(validateSubscriptionPatch({ ...base, type: '' }, subDb), null);
  assert.equal(validateSubscriptionPatch({ ...base, type: 'bogus' }, subDb), 'Invalid type');
  assert.equal(validateSubscriptionPatch({ ...base, label: 'x'.repeat(61) }, subDb), 'Label too long');
  assert.equal(validateSubscriptionPatch({ ...base, label: 'x'.repeat(60) }, subDb), null);
  // A caregiving type carries no leg, so the route must have cleared pd before we got here.
  assert.equal(validateSubscriptionPatch({ ...base, type: 'meal', pd: null }, subDb), null);
  // The sentinel DOES carry a leg — every from-title outcome is trip-typed.
  assert.equal(validateSubscriptionPatch({ ...base, type: '', pd: 'sideways' }, subDb), 'Invalid trip kind');
});
```

Append after the existing `validateSubscription accepts an absent child_id` test:

```js
test("validateSubscription accepts '' as the from-title sentinel", () => {
  assert.equal(validateSubscription({ ...feed, type: '' }, subDb), null);
  assert.equal(validateSubscription({ ...feed, type: '', pd: 'pickup' }, subDb), null);
  // '' is the ONLY non-key string that passes.
  assert.equal(validateSubscription({ ...feed, type: 'nope' }, subDb), 'Invalid type');
  assert.equal(validateSubscription({ ...feed, type: undefined }, subDb), 'Invalid type');
  // The sentinel carries a leg, so an invalid one is still caught.
  assert.equal(validateSubscription({ ...feed, type: '', pd: 'sideways' }, subDb), 'Invalid trip kind');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TZ=America/New_York node --test test/validate.test.js
```

Expected: FAIL — `''` returns `'Invalid type'` on create, and the merged-row test reports `null` where `'Label too long'` / `'Invalid trip kind'` is expected.

- [ ] **Step 3: Update the import and `validateSubscription`**

`lib/validate.js` line 1:

```js
import { TYPE_KEYS, PD_KEYS, isTrip, takesLeg } from './constants.js';
```

In `validateSubscription`, replace the type and pd lines:

```js
  // '' is the "from title" sentinel — the feed declares no activity and each event is typed from
  // its own title (lib/ical-map.js feedType). It is not a TYPE_KEYS member by design.
  if (b.type !== '' && !TYPE_KEYS.includes(b.type)) return 'Invalid type';
  if (takesLeg(b.type) && b.pd != null && b.pd !== '' && !PD_KEYS.includes(b.pd))
    return 'Invalid trip kind';
```

- [ ] **Step 4: Rewrite `validateSubscriptionPatch`**

Replace the function and its comment block:

```js
// PATCH of a saved subscription. `label`, `type`, `pd`, the pinned child and the rule map are
// editable; url/caregiver stay create-time (a changed URL means different UIDs, which re-imports the
// whole feed as duplicates). A null/'' child_id switches the feed to per-event routing.
//
// This validates the MERGED row — the route merges the body over the stored row first — so an
// invariant that spans fields is actually checked. Validating only the SUPPLIED fields would let a
// Sports → Bedtime switch keep its stale pd, which normalize() and lib/report.js then disagree
// about. Same rule as validateFamilyUpdate (an unarchive with no name bypassed name-uniqueness).
export function validateSubscriptionPatch(b, db) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  if (b.child_id) {
    const c = db.prepare('SELECT id FROM children WHERE id = ? AND archived = 0').get(b.child_id);
    if (!c) return 'Unknown or archived child';
  }
  if ((b.label == null ? '' : String(b.label).trim()).length > LIMITS.label) return 'Label too long';
  if (b.type !== '' && !TYPE_KEYS.includes(b.type)) return 'Invalid type';
  if (takesLeg(b.type) && b.pd != null && b.pd !== '' && !PD_KEYS.includes(b.pd))
    return 'Invalid trip kind';
  return validateChildMap(b.child_map, db);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
TZ=America/New_York node --test test/validate.test.js
```

Expected: PASS.

- [ ] **Step 6: Run the full suite unpiped**

```bash
TZ=America/New_York npm test
```

Expected: `# fail 0`. If `test/family.test.js` or a route test fails, it is calling `validateSubscriptionPatch` with a partial object — fix the caller, not the validator.

- [ ] **Step 7: Commit**

```bash
git add lib/validate.js test/validate.test.js
git commit -m "feat(ical): validate a subscription patch as a merged row"
```

---

### Task 3: Persist label/type/pd

**Files:**
- Modify: `lib/subscription-writes.js:3` (import), `:26` (`updateStmt`), `:31-45` (`createSubscription`), `:64-67` (`updateSubscription`)
- Modify: `app/api/subscriptions/[id]/route.js:30-45` (the PUT merge)
- Test: `test/subscription-writes.test.js`

**Interfaces:**
- Consumes: `takesLeg` (Task 1), `validateSubscriptionPatch` requiring a merged row (Task 2).
- Produces: `updateSubscription(id, { label, type, pd, child_id, child_map })` → the updated row. All five keys are required; the caller merges.

- [ ] **Step 1: Write the failing tests**

Append to `test/subscription-writes.test.js`:

```js
test('updateSubscription persists label, type and pd on the SAME row', () => {
  // Editing in place rather than delete + re-add is the entire point: a new subscription id would
  // orphan every imported event's subscription_id tag, so the next sync would match nothing and
  // re-import the whole feed as duplicates.
  const s = sw.createSubscription(feed({ label: 'old', type: 'sport', pd: 'dropoff' }));
  const u = sw.updateSubscription(s.id, {
    label: 'Cobb County swim',
    type: '',
    pd: 'both',
    child_id: null,
    child_map: {},
  });
  assert.equal(u.id, s.id);
  assert.equal(u.label, 'Cobb County swim');
  assert.equal(u.type, '');
  assert.equal(u.pd, 'both');
  assert.equal(u.url, s.url); // url is create-time and must survive the patch untouched
});

test('createSubscription stores a leg for the from-title sentinel', () => {
  // '' takes a leg because every from-title outcome is trip-typed; a caregiving type does not.
  const picked = sw.createSubscription(feed({ type: '', pd: 'pickup' }));
  assert.equal(picked.type, '');
  assert.equal(picked.pd, 'pickup');
  const defaulted = sw.createSubscription(feed({ type: '' }));
  assert.equal(defaulted.pd, 'dropoff');
  const caregiving = sw.createSubscription(feed({ type: 'meal' }));
  assert.equal(caregiving.pd, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TZ=America/New_York node --test test/subscription-writes.test.js
```

Expected: FAIL — label/type/pd come back unchanged from `updateSubscription`, and `createSubscription` returns `pd: null` for `type: ''`.

- [ ] **Step 3: Update `lib/subscription-writes.js`**

Line 3 — `isTrip`'s only use in this file is the `createSubscription` pd line you are about to replace, so it becomes unused. Replace the import outright:

```js
import { takesLeg } from './constants.js';
```

Replace `updateStmt`:

```js
const updateStmt = db.prepare(
  `UPDATE calendar_subscriptions
      SET label = @label, type = @type, pd = @pd, child_id = @child_id, child_map = @child_map
    WHERE id = @id`
);
```

In `createSubscription`, replace the `pd` line:

```js
    // pd is only meaningful for a type that carries a leg — a real trip type, or the '' sentinel
    // (every from-title outcome is trip-typed). Store 'dropoff' by default there, NULL otherwise.
    pd: takesLeg(b.type) ? b.pd || 'dropoff' : null,
```

Replace `updateSubscription`:

```js
// Patch a subscription's editable fields: label, activity type ('' = from title), leg, the pinned
// child (NULL = route by title) and the saved name→child assignments. url and caregiver_id stay
// create-time. The caller passes a MERGED row — an absent field must already have been filled from
// the stored row — so this is a plain write with no merge logic of its own.
export function updateSubscription(id, { label, type, pd, child_id, child_map }) {
  updateStmt.run({
    id,
    label: (label || '').trim(),
    type,
    pd: pd || null,
    child_id: child_id || null,
    child_map: JSON.stringify(child_map || {}),
  });
  return getById.get(id);
}
```

- [ ] **Step 4: Update the PUT handler**

In `app/api/subscriptions/[id]/route.js`, add `takesLeg` to the constants import (add the import line if absent):

```js
import { takesLeg } from '@/lib/constants';
```

Replace the `patch` object:

```js
  // An absent field means "unchanged"; an explicit null/'' child_id switches to per-event routing.
  // Merged HERE so the validator can check invariants that span fields — pd's coherence with the
  // resulting type in particular.
  const type = b.type === undefined ? sub.type : b.type;
  const patch = {
    label: b.label === undefined ? sub.label : String(b.label ?? '').trim(),
    type,
    // Recomputed from the MERGED type: switching a feed to a caregiving type must drop the leg, or
    // normalize() and lib/report.js disagree about whether its events are transport.
    pd: takesLeg(type) ? (b.pd === undefined ? sub.pd || 'dropoff' : b.pd || 'dropoff') : null,
    child_id: b.child_id === undefined ? sub.child_id : b.child_id || null,
    child_map: b.child_map === undefined ? parseChildMap(sub.child_map) : b.child_map,
  };
```

Update the handler's block comment — it currently says "url/type/parent stay create-time", which is now wrong. Replace that sentence with "url/parent stay create-time; label, type and leg are editable."

- [ ] **Step 5: Run the tests to verify they pass**

```bash
TZ=America/New_York node --test test/subscription-writes.test.js
```

Expected: PASS.

- [ ] **Step 6: Run the full suite unpiped**

```bash
TZ=America/New_York npm test
```

Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add lib/subscription-writes.js "app/api/subscriptions/[id]/route.js" test/subscription-writes.test.js
git commit -m "feat(ical): make a subscription's label, activity and leg patchable"
```

---

### Task 4: The UI

**Files:**
- Modify: `components/Settings.js:6` (import), `:214-264` (`NameRule` neighbourhood — add `FeedEdit` after it), `:272-500` (`CalendarSubscriptions`)
- Modify: `app/globals.css:290` (after `.sub-rule-title`)

**Interfaces:**
- Consumes: `takesLeg` (Task 1), the PUT contract (Task 3).
- Produces: no exports; `FeedEdit` is module-private like `NameRule`.

- [ ] **Step 1: Add `takesLeg` to the Settings import**

`components/Settings.js` line 6:

```js
import { TYPES, isTrip, takesLeg } from '@/lib/constants';
```

- [ ] **Step 2: Add the `FeedEdit` component**

Insert directly after `NameRule` ends (`components/Settings.js:264`):

```jsx
// The editable half of a subscription row: label, activity and leg. Rendered BELOW the table, never
// inside a <td> — a text input plus two 16px touch-sized selects would widen .report-table and bury
// these controls behind sideways panning at 375px (the same reasoning as the routing rules below,
// and the failure kin.md records twice). Reuses .sub-rule, so the touch sizing in the
// (pointer: coarse) block already covers it.
function FeedEdit({ sub, busy, onSave, onCancel }) {
  const [label, setLabel] = useState(sub.label || '');
  const [type, setType] = useState(sub.type);
  const [pd, setPd] = useState(sub.pd || 'dropoff');
  const leg = takesLeg(type);
  const dirty =
    label.trim() !== (sub.label || '') || type !== sub.type || (leg && pd !== (sub.pd || 'dropoff'));
  return (
    <div className="sub-rule sub-edit">
      <span className="sub-rule-key">Feed settings</span>
      <input
        type="text"
        className="sub-rule-title"
        aria-label="Subscription label"
        value={label}
        placeholder="e.g. Cobb County swim"
        maxLength={60}
        autoFocus
        onChange={(e) => setLabel(e.target.value)}
      />
      <select
        aria-label="Activity for this feed"
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        {Object.entries(TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
        <option value="">— from title (match each title) —</option>
      </select>
      {leg && (
        <select aria-label="Leg for this feed" value={pd} onChange={(e) => setPd(e.target.value)}>
          <option value="dropoff">Drop-off</option>
          <option value="pickup">Pickup</option>
          <option value="both">Both</option>
        </select>
      )}
      <button
        className="btn"
        onClick={() => onSave({ label: label.trim(), type, pd: leg ? pd : null })}
        disabled={busy || !dirty}
      >
        Save
      </button>
      <button className="btn" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Add editing state, the focus-restore effect, and the save handler**

Inside `CalendarSubscriptions`, after `const [saving, setSaving] = useState(false);`:

```js
  const [editing, setEditing] = useState(''); // subscription id whose editor strip is open
  // Focus restore lives in the HOST, not FeedEdit: the strip is conditionally MOUNTED, so capturing
  // the opener inside it would run after autoFocus has already moved focus, and a restore in its
  // unmount cleanup fires once ON OPEN under StrictMode's setup→cleanup→setup. Capture in the click
  // handler, restore in an effect gated on the open flag. (kin.md client-state rule.)
  const editOpener = useRef(null);
  useEffect(() => {
    if (editing) return;
    const el = editOpener.current;
    editOpener.current = null;
    el?.focus();
  }, [editing]);

  async function saveFeed(sub, patch) {
    setSaving(true);
    try {
      const r = await familyReq(`/api/subscriptions/${sub.id}`, 'PUT', patch, onAuthError);
      if (r.ok) {
        setEditing('');
        await onChanged();
      }
    } finally {
      setSaving(false);
    }
  }
```

`useRef` and `useEffect` are already imported at `components/Settings.js:3`.

- [ ] **Step 4: Add the "from title" option to the add form**

Replace the add-form Activity select (`components/Settings.js:370-372`):

```jsx
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
            {/* Last, mirroring the Child select's "— per event —": both mean "don't pin this, read
                it off each event". */}
            <option value="">— from title (match each title) —</option>
          </select>
```

Change the `trip` const (`components/Settings.js:285`):

```js
  const trip = takesLeg(type);
```

- [ ] **Step 5: Update the row's Activity cell and add the Edit button**

Replace the Activity `<td>` (`components/Settings.js:413-418`):

```jsx
                  {/* On a per-event feed a real type is only the FALLBACK — each group's own
                      activity wins — so labelling it plainly would misdescribe what the events
                      actually got. In from-title mode nothing is a default, so no suffix. */}
                  <td>
                    {s.type === ''
                      ? 'From title'
                      : `${TYPES[s.type]?.label || s.type}${s.child_id ? '' : ' (default)'}`}
                  </td>
```

Replace the actions `<td>` (`components/Settings.js:424-429`):

```jsx
                  <td className="sub-actions">
                    <button
                      className="btn"
                      onClick={(e) => {
                        editOpener.current = e.currentTarget;
                        setEditing(editing === s.id ? '' : s.id);
                      }}
                    >
                      {editing === s.id ? 'Close' : 'Edit'}
                    </button>
                    <button className="btn" onClick={() => sync(s.id)} disabled={syncing === s.id}>
                      {syncing === s.id ? 'Syncing…' : 'Sync now'}
                    </button>
                    <button className="btn btn-del" onClick={() => remove(s.id)}>Delete</button>
                  </td>
```

- [ ] **Step 6: Render the editor strip below the table**

Add this as a **sibling immediately after** the whole `{subscriptions.length > 0 && ( … )}` block closes — i.e. after its `)}`, not inside it and not inside `.table-scroll`. Nesting it in the scroll container would put the editor behind the same sideways pan this design exists to avoid:

```jsx
      {/* keyed by id so switching rows remounts with that feed's values instead of stale state */}
      {subscriptions.some((s) => s.id === editing) && (
        <FeedEdit
          key={editing}
          sub={subscriptions.find((s) => s.id === editing)}
          busy={saving || syncing === editing}
          onSave={(patch) => saveFeed(subscriptions.find((s) => s.id === editing), patch)}
          onCancel={() => setEditing('')}
        />
      )}
```

The `subscriptions.some(...)` guard matters: deleting the feed being edited would otherwise pass `sub={undefined}` into `FeedEdit` and crash the page.

- [ ] **Step 7: Keep `defaultType` in lockstep with `routeTitle`**

At `components/Settings.js:480-482`, replace:

```jsx
                  defaultType={
                    (!namesChild && isTrip(s.type) && guessType(e.seg || k)) || s.type
                  }
```

with:

```jsx
                  // Mirrors routeTitle EXACTLY (lib/ical-map.js) — including the '' sentinel branch
                  // and the `other` resort. A divergence here shows the user a different guess than
                  // the one that actually gets imported.
                  defaultType={
                    (!namesChild && (s.type === '' || isTrip(s.type)) && guessType(e.seg || k)) ||
                    s.type ||
                    'other'
                  }
```

- [ ] **Step 8: Add the `.sub-edit` rule**

In `app/globals.css`, after `.sub-rule-title` (line 290):

```css
/* The feed editor strip: same flex row as .sub-rule (so the (pointer: coarse) sizing below covers
   its input and selects), sitting under the subscription table rather than inside a <td>. */
.sub-edit{max-width:560px;margin-top:6px;border-bottom:none;}
```

- [ ] **Step 9: Verify the build**

```bash
npm run build
```

Expected: success, `output: 'standalone'` intact.

- [ ] **Step 10: Run the full suite unpiped**

```bash
TZ=America/New_York npm test
```

Expected: `# fail 0`.

- [ ] **Step 11: Commit**

```bash
git add components/Settings.js app/globals.css
git commit -m "feat(ical): edit a feed's label and activity in place"
```

---

### Task 5: Docs, and the verification gate

**Files:**
- Modify: `docs/ical-subscriptions.md`
- Modify: `CLAUDE.md` (the iCal subscriptions paragraph in **Data model**)

- [ ] **Step 1: Update `docs/ical-subscriptions.md`**

In the **Activity type** section, add the from-title mode above the existing precedence list:

```markdown
A feed's activity is either a fixed type or **from title** (`type = ''` — no migration; the column is
NOT NULL, so the empty string stands in for NULL). From-title is the activity mirror of the Child
column's "per event": the feed declares no activity and each event is typed from its own title, via
an explicit per-group choice, else a keyword guess from the leading segment, else `other`.

Every from-title outcome is trip-typed — every keyword target, plus the `other` resort — so the mode
cannot fabricate or destroy a transport leg in the involvement report. That property is asserted in
`test/ical-map.test.js`; adding a caregiving keyword would break it, and the pd question has to be
answered first.
```

Add a new section after it:

```markdown
## Editing a feed

`label`, activity `type` and the `pd` leg are editable on a saved subscription (Settings → the
subscription table → **Edit**). `url` and the transport parent stay create-time.

Editing in place is not just convenience. Delete + re-add mints a new subscription id and clears
`subscription_id` on every event that feed already imported, so the next sync matches nothing and
re-imports all of them as duplicates. The Edit path keeps the id, so the dedup tags stay valid.

The PUT validates the **merged** row, not the supplied fields: switching a feed to a caregiving type
clears `pd`, because a stale leg would leave `normalize()` and `lib/report.js` disagreeing about
whether the feed's events count as transport.

**Limitation:** per-group activity overrides exist only for a per-event (unpinned) feed — that is
where the routing-rule list lives. A pinned feed in from-title mode gets the keyword guess with no
per-group correction UI; a wrong guess is fixed by editing the event on the calendar. Safe because
every from-title outcome is trip-typed, so a wrong guess is cosmetic and cannot move the report.
```

If the "Out of scope" section lists per-event activity type, leave it — it now describes the pinned-feed limitation above. If it claims activity is per-feed only, correct it.

- [ ] **Step 2: Update `CLAUDE.md`**

In the iCal subscriptions paragraph under **Data model**, after the sentence describing `child_id` as nullable, add:

```
`type` is likewise overloaded: `''` is the **from title** sentinel (no migration — the column is NOT
NULL) meaning the feed pins no activity and each event is typed from its own title (`feedType` /
`routeTitle` in `lib/ical-map.js`, resorting to `other`). `takesLeg(type)` in `lib/constants.js` is
the shared "does this type carry a pd leg" predicate — true for a trip type or the sentinel. `label`,
`type` and `pd` are patchable via `PUT /api/subscriptions/[id]`, which validates the MERGED row;
`url` and `caregiver_id` stay create-time.
```

- [ ] **Step 3: Run the full gate**

```bash
TZ=America/New_York npm test
npm run build
```

Run `npm test` **unpiped** and read the `# pass` / `# fail` counts. Both must be clean before the commit below.

- [ ] **Step 4: Browser-verify at 375px**

Start a production build on a spare port with a fresh DB, mint a session with
`POST /api/auth/login` (**never type the password into a field**), inject `tt_session` via
`document.cookie`, and open `/settings`.

Check, in order:

1. Add a feed with Activity = **— from title —**. The Leg select must appear (the sentinel carries a leg).
2. The row's Activity cell reads `From title`, with no `(default)` suffix.
3. Click **Edit**. The strip appears below the table with the label input focused.
4. Change the label, Save. The row updates and the subscription id is unchanged (check
   `GET /api/subscriptions`); a re-sync adds **0**.
5. Switch a feed to a caregiving type (e.g. Meals) and Save. The Leg select disappears and the stored
   `pd` comes back `null`.
6. At a 375px viewport, with the editor strip **open**, assert the page does not pan sideways:

```js
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

   `resize_window` may not actually narrow the viewport here — clamp the element width and read
   `getComputedStyle` / `scrollWidth > clientWidth` instead of trusting the resize (kin.md).
7. 0 console messages, no page errors.

- [ ] **Step 5: Commit**

```bash
git add docs/ical-subscriptions.md CLAUDE.md
git commit -m "docs(ical): from-title activity and editable feed settings"
```

---

## Self-review notes

**Spec coverage:** §1 sentinel → Task 1 + 2. §2 resolution order → Task 1. §3 routeTitle → Task 1 Step 5. §4 `feedType` + pinned path → Task 1 Steps 4, 6. §5 pd/Leg → Task 1 (`takesLeg`), Task 3 (create), Task 4 (form). §6 patchable fields → Tasks 2, 3. §7 UI → Task 4. Out-of-scope items → documented in Task 5 Step 1. Every spec section maps to a task.

**Type consistency:** `takesLeg` (`lib/constants.js`) and `feedType` (`lib/ical-map.js`) are used under those exact names in Tasks 2, 3 and 4. `updateSubscription`'s five-key destructure matches the PUT handler's `patch` object key-for-key.

**Known breakage, handled:** Task 2 rewrites `test/validate.test.js:171` because merged-row validation makes its partial-object inputs invalid. Called out at the top of that task so an implementer doesn't "fix" it by weakening the validator.

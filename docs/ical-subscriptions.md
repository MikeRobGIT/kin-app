# iCal feed subscriptions

The research record behind saved `.ics` subscriptions (migration 12) and per-event child routing
(migration 13), plus the implementation reference.

> Informational only — the authoritative behavior is `lib/ical.js`, `lib/ical-map.js`, and
> `app/api/subscriptions/[id]/sync/route.js`.

## The model

A subscription is a saved feed URL plus the mapping Kin applies to everything it imports:

```
subscription = url + label + type + caregiver_id + pd + (child_id | NULL)

child_id set   → PINNED:    every occurrence belongs to that child.
child_id NULL  → PER-EVENT: each occurrence is routed to a child by the name in its title.
```

Sync is **add-only**. It never updates or deletes an already-imported event, so a manual edit to an
imported row is never clobbered and re-syncing is always safe. The window is today−60d … today+365d
and slides forward on each pull.

Dedup keys on `(subscription_id, ical_uid, date, ical_key)`, and has to survive a feed being switched
between the two modes — they write different `ical_key` shapes, and an exact-key lookup would miss
every existing row and re-import the whole feed as duplicates:

- **pinned** ignores `ical_key` entirely. `uid`+`date` is unique per subscription when one child owns
  every event, which is also exactly what a per-event → pinned switch needs.
- **per-event** matches the exact routing key *or* a legacy `NULL` key left by a pinned import. The
  non-null half stops two kids sharing one `uid`+`date` from colliding; the `NULL` half covers the
  pinned → per-event switch.

An occurrence that can't be routed but already has a `NULL`-keyed row is reported as *skipped*, not
*pending* — it is already on the calendar, so it isn't waiting on an assignment.

### Switching an existing feed's mode

The mode is chosen when the feed is added; Settings has no control to change it afterwards. `PUT
/api/subscriptions/[id]` with a `child_id` will change it, but **understand what it does not do**:
sync is add-only, so events already imported under the old mode keep the child they were filed
under. Switching a pinned feed to per-event re-routes only *future* occurrences.

Worse, if the feed's UID identifies the class rather than the registration, the second child's
occurrences were never imported at all under pinned mode — and after the switch they match the first
child's `NULL`-keyed row and stay skipped. They cannot be recovered by switching.

To genuinely re-file an existing feed: delete its imported events first, then switch and re-sync.

## Resolution precedence (per-event feeds)

For each occurrence, `routeTitle` (`lib/ical-map.js`) resolves in this order:

1. **A saved rule** for the occurrence's `match_key` → that child. The user's decision is final and
   beats any name match.
2. **Auto-match** — exactly one *active* child's name appears in the leading segment → that child,
   and that name's segment is stripped from the title.
3. **Otherwise → held.** The event is *not* imported. Its key is recorded in `child_map` (with an
   empty child and the original-case segment) and listed in Settings for a one-time assignment.

A wrong child on a custody record is worse than an event that waits, so ambiguity never guesses:
zero matches, two-or-more matches, and a rule pointing at a since-archived child all fall to (3).
A rule whose child is archived therefore **self-heals** back into the review list rather than
failing validation and aborting the sync.

## The match key

The **leading segment** of `SUMMARY` — the text before the first separator — normalized (lowercased,
runs of non-letter/digit collapsed to single spaces).

| Separator | Requires |
|---|---|
| `-` `–` `—` `\|` | a space on **both** sides, so `Minnows (3yr-5yr)` doesn't split |
| `:` | a trailing space, so `Swim 9:00 AM - Pool` splits at the dash, not the clock |

No separator → the whole title is the segment.

Matching is **whole-word set membership**, never substring (a child named `Mia` must not match
`Miami Swim`) and never regex against the roster name (a name is user data: `A.J.` as a pattern
would match `AQJ`, and JS `\b` is ASCII-only). Only the leading segment is scanned — it is the
registrant field. Scanning the whole title would mis-route `Owen Carter - Fun Run (Poison Ivy Trail)`,
`... - Beginner Swim w/ Coach Ivy`, and `Minnows - at Ivy League Pool`.

Because the key is the segment, one assignment covers every event that shares it.

## Two real feed shapes

**Name-prefixed** (the class portal's *web* calendar):

```
Ivy Carter - Minnows (3yr-5yr)          → key "ivy carter"        → Ivy,      title "Minnows (3yr-5yr)"
Owen Carter - Beginner Swim             → key "owen carter"       → Owen,     title "Beginner Swim"
```
Auto-matches with no setup; the name segment is stripped because the child is already a colour-coded
field.

**Class-prefixed** (the same portal's actual `.ics` export — `secure.rec1.com`):

```
SUMMARY:Minnows (3yr-5yr) - WCAC Sat 10:30 am              → key "minnows 3yr 5yr"
SUMMARY:Beginner Swimming (5yr-15yr) - WCAC Sat 11:10 am   → key "beginner swimming 5yr 15yr"
```
The export carries **no registrant name at all**, so nothing auto-matches. Instead the feed's 12
occurrences collapse to **two** keys — one per class — and two assignments route all of them, plus
every future week.

## Titles

Which half of a title survives depends on what the leading segment *is*, and the two feed shapes are
exact opposites:

| Segment | Example | Imported title |
|---|---|---|
| names a child | `Ivy Carter - Minnows (3yr-5yr)` | `Minnows (3yr-5yr)` — the name is dropped |
| doesn't | `Minnows (3yr-5yr) - WCAC Sat 10:30 am` | `Minnows (3yr-5yr)` — the tail is dropped |

In the first case the segment is a "who" prefix and the child is already a colour-coded field, so it
is redundant. In the second the segment is the activity group the user named, and the tail is
per-occurrence noise — venue, day, and time, all of which Kin already stores as `notes`, `date` and
`time`. The name-dropping rule applies to auto-matches **and** to a rule whose key happens to name a
child (`Ivy & Owen - Family Swim` → `Family Swim`), so assigning an ambiguous group never
titles an event after a person.

Each rule also carries an optional **custom title** (`t`), editable in Settings and pre-filled with
the default above, which wins over both. Held events keep their full original title so the review
list shows what actually arrived.

Titles are only ever rewritten on a per-event feed. A feed pinned to one child imports `SUMMARY`
verbatim, exactly as before v13 — sync is add-only, so rewriting mid-stream would leave two title
styles side by side for the same weekly class.

## Timezones

`lib/ical.js` stores each occurrence as the family's wall-clock. The zone is **`NEXT_PUBLIC_TZ`**
(`RECORDED_TZ` in `lib/format.js`, default `America/New_York`) — the same setting the rest of the app
formats with — resolved once at module load.

It is deliberately **not** the process zone. Nothing in `Dockerfile`, `docker-compose.yml`, or
`docker-entrypoint.sh` sets `TZ`, so a deployed container runs UTC; reading local `Date` getters
would leave a `14:30Z` event at 14:30 in production and push a `TZID`-authored 09:00 to 13:00. A
malformed `NEXT_PUBLIC_TZ` falls back to the default rather than throwing mid-sync (which the route
would surface as a misleading "Could not parse calendar").

Two deployment notes:

- `NEXT_PUBLIC_*` is **inlined at build time** by Next, and `docker-compose.yml` doesn't pass it as a
  build `ARG` — so setting it in the runtime environment will not change import times. It has to be
  set for the build. The default matches the family's zone, so nothing is wrong today.
- This variable now decides **recorded event data**, not just how a timestamp is displayed. Changing
  it does not retroactively fix events already imported: dedup is on `uid`+`date`, and a few hours'
  shift rarely crosses midnight, so a re-sync skips them. Events imported by v12 from a UTC feed
  before this fix keep their wrong times and must be deleted and re-imported.

| DTSTART kind | Handling |
|---|---|
| all-day (`VALUE=DATE`) | a calendar date, not an instant — never converted; time forced to `08:00` |
| floating (no `TZID`, no `Z`) | already authored wall-clock — used as-is |
| absolute (`Z`, or a `TZID` the feed defines with a `VTIMEZONE`) | a true instant — **converted** into the configured zone |

That last row is load-bearing: the rec1.com feed emits `DTSTART:20260815T143000Z` with no
`VTIMEZONE` for a class its own `SUMMARY` calls "Sat 10:30 am". Read as authored wall-clock it
imported four hours late. Note a `TZID` with no matching `VTIMEZONE` cannot be resolved by `ical.js`
and falls back to floating — authored wall-clock, the safest available reading.

## Activity type

A feed's activity is either a fixed type or **from title** (`type = ''` — no migration; the column is
NOT NULL, so the empty string stands in for NULL). From-title is the activity mirror of the Child
column's "per event": the feed declares no activity and each event is typed from its own title, via
an explicit per-group choice, else a keyword guess from the leading segment, else `other`.

Every from-title outcome is trip-typed — every keyword target, plus the `other` resort — so the mode
cannot fabricate or destroy a transport leg in the involvement report. That property is asserted in
`test/ical-map.test.js`; adding a caregiving keyword would break it, and the pd question has to be
answered first.

`routeTitle`'s `fallbackType` parameter defaults to `''` — the same sentinel, not an inert "no type".
The sync route always passes the subscription's own `type` explicitly, so the default only matters to
a caller that omits the argument: doing so opts INTO from-title guessing, not out of type resolution.

Per occurrence, on a per-event feed only:

1. The group's explicit type (`y` on its `child_map` entry) — the user's override.
2. `guessType(seg)` — an ordered keyword table.
3. The subscription's own `type` — what every event got before this.
4. `'other'` — the final resort; the chain can never yield `''`.

`y: ''` means **auto**, so a user who only came to pick a child never pins a type. Settings shows the
guess as the *label* of the auto option (`Auto — Sports`), never a pre-selected value: a pre-selected
value submits, which would freeze the guess on first Save and stop a later improvement to the table
from reaching that group. Same reasoning as the custom title.

Four rules make the guess safe:

- **Guess from the leading segment, and only when it isn't a name prefix.** An auto-name-matched
  group never enters `child_map`, so it has no review row — a wrong guess there would be
  uncorrectable short of editing every event. The type comes from `seg` exactly when the title does.
- **Whole-word matching.** `(' '+normKey(t)+' ').includes(' '+hint+' ')`. Variants are listed
  explicitly (`swim`, `swimming`), never inferred by prefix — which is what stops `Campbell` and
  `Campus` matching `camp`, `Gymnasium` matching a `gym` hint, `Meeting` matching `meet`. First match
  wins, so order decides ties: format beats discipline (`Swim Camp` → Camp) and a superstring
  precedes its prefix (`after school` → Daycare, not School).
- **Never cross the trip/non-trip line.** Doing so silently rewrites the involvement report in both
  directions: `normalize()` forces `pd`, so a non-trip feed guessing a trip type **invents** a
  drop-off leg credited to the feed's parent, and a trip feed guessing a non-trip type **destroys**
  one. Neither is visible in the UI. That takes *two* rules, not one: hint targets are restricted to
  `school tutor therapy daycare sport gym camp` (blocking trip → non-trip), **and** guessing is
  skipped unless the subscription's own type is trip-typed, **or** the feed is itself in from-title
  mode (`type === ''`). That still blocks non-trip → trip for a fixed-type feed — one added as
  "Activity / Playdate" keeps that type for everything — without reopening the hole for from-title:
  every hint target and the `other` resort are trip-typed, so from-title mode has no non-trip outcome
  to land on. An explicit `y` is exempt: the user picked it from a full list.
- **Only guess on a real `SUMMARY`.** With none, the sync route synthesizes a title from the feed's
  own type label — a `schoolevent` feed yields "School event", whose `school` hint is a *different*,
  trip-typed key, so a title-less occurrence would quietly gain a transport leg.

`HINTS` is filtered once at load to keys present in `TYPES`. Without that guard a hint naming a
missing key reaches the imported row, fails `validateEventFields` with `'Invalid type'`, and makes
the sync route return 400 and abort the **entire** pull — permanently, with a status naming the wrong
cause. Two unit-test invariants enforce it: every target live and trip-typed, every hint already
normalized.

`lib/seal.js` seals `type` into the monthly record. Sync is add-only, so no imported row's type is
ever retro-mutated — don't "improve" this into a re-typing pass.

## Editing a feed

`label`, activity `type` and the `pd` leg are editable on a saved subscription (Settings → the
subscription table → **Edit**). `url` and `caregiver_id` stay create-time.

Editing in place is not just convenience. Delete + re-add mints a new subscription id and clears
`subscription_id` on every event that feed already imported, so the next sync matches nothing and
re-imports all of them as duplicates. The Edit path keeps the id, so the dedup tags stay valid.

The PUT validates the **merged** row, not the supplied fields: switching a feed to a caregiving type
clears `pd`, because a stale leg would leave `normalize()` and `lib/report.js` disagreeing about
whether the feed's events count as transport.

**Not retroactive.** Sync is add-only and, as stated above, `lib/seal.js` seals each event's `type`
at import — changing the subscription's own `type` afterwards doesn't touch it. Switching a feed
from Sports to Bedtime leaves already-imported events typed `sport`; the subscription row now reads
"Bedtime", but history doesn't rewrite. Same principle as reassigning a routing rule (see
"Reassignment is forward-only" in "Out of scope" below): those events stay ordinary,
individually-editable rows on the calendar.

**Limitation:** per-group activity overrides exist only for a per-event (unpinned) feed — that is
where the routing-rule list lives. A pinned feed in from-title mode gets the keyword guess with no
per-group correction UI; a wrong guess is fixed by editing the event on the calendar. Safe because
every from-title outcome is trip-typed, so a wrong guess is cosmetic and cannot move the report.

## Data model (migrations 12 & 13)

- `calendar_subscriptions(id, label, url, child_id, type, caregiver_id, pd, created_at,
  last_synced_at, last_status, child_map)` — `child_id` is nullable (v13); `child_map` is a JSON
  object keyed by normalized title segment. A value is either a bare child id (`''` = pending) or
  `{ c: child_id, t: custom title, s: original-case segment, y: activity type }`;
  `lib/ical-map.js ruleEntry()` normalizes both so callers never branch. `t` and `y` empty both mean
  "use the default", recomputed per event. Adding `y` needed **no migration** — the entry was already
  a JSON blob. Bounded and existence-checked in `lib/validate.js`
  (`validateChildMap`, `RULE_LIMITS`) since SQLite can't FK into JSON — the same discipline as
  `schedules.assignment`.
- `events.subscription_id`, `events.ical_uid`, `events.ical_key` — nullable plain TEXT, **no FK**:
  dedup tags, not integrity anchors. Index `idx_events_ical(subscription_id, ical_uid, date,
  ical_key)`.

`child_map` lives on the subscription rather than in its own table for two reasons: it rides
`lib/export.js`'s `SELECT *` (a new table would have to be hand-added there), and the rules die with
their subscription — a rules table FK'd to `calendar_subscriptions` with no `ON DELETE` would make
any feed that had ever produced a pending rule undeletable, since `foreign_keys` is ON at runtime.

`last_status` doubles as the needs-attention signal: a pull that holds events writes
`"N events need a child"`, which the Settings table already renders, so held events stay visible
across syncs the user didn't watch.

## API

- `GET /api/subscriptions` — list. `POST` — create (does not sync; the client calls sync next).
- `PUT /api/subscriptions/[id]` — patch `label`, `type`, `pd`, `child_id` (null ⇒ per-event) and/or
  the whole `child_map`; validates the MERGED row (see "Editing a feed"). `url` and `caregiver_id`
  stay create-time.
- `DELETE /api/subscriptions/[id]` — remove; imported events are kept, their tag cleared.
- `POST /api/subscriptions/[id]/sync` — pull. Returns `{ added, skipped, pending, total }`.

All `force-dynamic` and `isAuthed`-gated; event writes go through the transactional, audited helpers
in `lib/event-writes.js`.

## Out of scope (v1)

- **Non-trip activity guesses.** The keyword table targets trip types only, so a feed of dentist or
  orthodontist appointments keeps the subscription's own type. See "Activity type" for why.
- **Activity on a name-prefixed feed.** Its groups are people, so there's nothing sensible to attach
  an activity to; those feeds keep the subscription's type, exactly as before.
- **Reassignment is forward-only.** Changing an assigned rule affects events imported from then on;
  already-imported events keep their child. Sync is add-only, and `lib/seal.js` seals `child_id`
  into the monthly record — retro-mutation would make a sealed month read as tampered.
- **One occurrence → two children** (`Ivy & Owen - Family Swim`). An event has a single
  `child_id`; such a title goes to review and gets one child, and the other is added by hand.
- **Automatic background sync.** "Sync now" is manual.
- **Activity-first auto-match.** A feed like `Minnows - Ivy Carter` gets no auto-match (the name
  isn't in the leading segment) and costs one assignment per class. Widening to a whole-title
  fallback would reintroduce the coach/venue/distance false positives above.
- **SSRF private-range blocking** on the feed fetch — scheme validation only, deliberate for a
  single-user self-hosted app whose only actor is the admin fetching their own kid's calendar.
- **A person's name in the LEADING segment always auto-matches**, whoever they are. The guarded
  examples above (`Fun Run (Poison Ivy Trail)`, `w/ Coach Ivy`, `at Ivy League Pool`) all put the false
  positive in the *tail*. A feed that leads with a venue or instructor sharing a child's first name —
  `Ivy League Pool - Swim Lesson` — still routes to Ivy. Segment-only matching narrows the
  exposure; it doesn't eliminate it.
- **Changing a feed's routing mode in the UI** — see "Switching an existing feed's mode" above.

## Sources

- RFC 5545 (iCalendar); expansion via the `ical.js` package.
- Example feed: `secure.rec1.com/GA/cobb-county-ga/feed/calendar/<token>` (Cobb County, GA rec portal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normKey, nameSegment, hasName, stripName, routeTitle, parseChildMap, ruleEntry, guessType, HINTS,
  feedType,
} from '../lib/ical-map.js';
import { TYPES, TYPE_KEYS } from '../lib/constants.js';

// The active roster as the sync route passes it: {id, name}, archived rows already filtered out.
const kids = [
  { id: 'c1', name: 'Ivy' },
  { id: 'c2', name: 'Owen' },
];

test('a name-prefixed title routes to its child with the name segment stripped', () => {
  // An explicit, real fallbackType — this test is about name-stripping, not type resolution, so it
  // must stay insulated from the from-title sentinel default (see the dedicated default-mode test).
  assert.deepEqual(routeTitle('Ivy Carter - Minnows (3yr-5yr)', kids, {}, 'sport'), {
    key: 'ivy carter',
    seg: 'Ivy Carter',
    child_id: 'c1',
    title: 'Minnows (3yr-5yr)',
    type: 'sport',
  });
  assert.deepEqual(routeTitle('Owen Carter - Beginner Swim', kids, {}, 'sport'), {
    key: 'owen carter',
    seg: 'Owen Carter',
    child_id: 'c2',
    title: 'Beginner Swim',
    type: 'sport',
  });
});

test('ruleEntry normalizes both stored shapes', () => {
  assert.deepEqual(ruleEntry('c1'), { child_id: 'c1', title: '', seg: '', type: '' });
  assert.deepEqual(ruleEntry(''), { child_id: '', title: '', seg: '', type: '' });
  assert.deepEqual(ruleEntry({ c: 'c2', t: 'Swim', s: 'Beginner Swim', y: 'camp' }), {
    child_id: 'c2', title: 'Swim', seg: 'Beginner Swim', type: 'camp',
  });
  assert.deepEqual(ruleEntry({ c: '', s: 'Minnows (3yr-5yr)' }), {
    child_id: '', title: '', seg: 'Minnows (3yr-5yr)', type: '',
  });
  assert.deepEqual(ruleEntry(undefined), { child_id: '', title: '', seg: '', type: '' });
});

// ---- activity-type guessing --------------------------------------------------

test('every hint targets a live, TRIP-typed key and is its own normKey', () => {
  // Two invariants that together prevent the worst failure this table can cause. A hint naming a key
  // absent from TYPES would reach the imported row, fail validateEventFields with 'Invalid type', and
  // make the sync route 400 and abort the ENTIRE pull — every time, permanently. A hint that isn't
  // already normalized could never match, so it would be silently dead weight.
  assert.ok(HINTS.length > 0);
  for (const [hint, key] of HINTS) {
    assert.ok(TYPE_KEYS.includes(key), `hint "${hint}" → unknown type "${key}"`);
    assert.equal(TYPES[key].trip, true, `hint "${hint}" → non-trip type "${key}"`);
    assert.equal(hint, normKey(hint), `hint "${hint}" is not in normalized form`);
  }
  // The `other` resort closes the same loop: from-title mode has NO non-trip outcome to land on,
  // which is what lets it exist without a per-group override on every feed shape.
  assert.equal(TYPES.other.trip, true, 'the `other` resort must be trip-typed');
});

test('guessType types the real feed segments with no user input', () => {
  assert.equal(guessType('Beginner Swimming (5yr-15yr)'), 'sport');
  assert.equal(guessType('Minnows (3yr-5yr)'), 'sport');
  assert.equal(guessType('Summer Day Camp'), 'camp');
});

test('guessType ordering: format beats discipline, superstring beats prefix', () => {
  assert.equal(guessType('Swim Camp'), 'camp'); // a week of camp is a camp, not a sport
  assert.equal(guessType('Gymnastics Camp'), 'camp');
  assert.equal(guessType('After School Club'), 'daycare'); // not 'school'
  assert.equal(guessType('School Pickup'), 'school');
});

test('guessType matches whole words only — no prefix false positives', () => {
  // Each of these is a plausible title on a Cobb County feed, and each would match under word-START
  // matching. Whole-word membership rules them all out by construction.
  assert.equal(guessType('Campbell HS Orientation'), null);
  assert.equal(guessType('Campus Center Tour'), null);
  assert.equal(guessType('Basketball at Main Gymnasium'), 'sport'); // 'gym' is deliberately NOT a hint
  assert.equal(guessType('Parent Meeting'), null); // 'meet' is NOT a hint
  assert.equal(guessType('Media Club'), null); // 'med' is NOT a hint
  assert.equal(guessType('Denton Park Cleanup'), null); // 'dent' is NOT a hint
});

test('guessType returns null rather than guessing when nothing matches', () => {
  assert.equal(guessType('WCAC Sat 10:30 am'), null);
  assert.equal(guessType(''), null);
  assert.equal(guessType(null), null);
});

test('routeTitle type precedence: explicit rule > guess > the feed default', () => {
  const seg = 'Beginner Swimming (5yr-15yr)';
  const t = `${seg} - WCAC Sat 11:10 am`;
  assert.equal(routeTitle(t, kids, { 'beginner swimming 5yr 15yr': 'c2' }, 'other').type, 'sport');
  const pinned = { 'beginner swimming 5yr 15yr': { c: 'c2', t: '', s: seg, y: 'camp' } };
  assert.equal(routeTitle(t, kids, pinned, 'other').type, 'camp');
  // y:'' is AUTO, not a pin — it must not suppress the guess.
  const auto = { 'beginner swimming 5yr 15yr': { c: 'c2', t: '', s: seg, y: '' } };
  assert.equal(routeTitle(t, kids, auto, 'other').type, 'sport');
  assert.equal(routeTitle('WCAC Sat 10:30 am', kids, {}, 'other').type, 'other');
});

test('a segment that NAMES a child never guesses — it has no review row to correct', () => {
  // "Ivy swim lesson" has no separator, so the segment IS the whole title and `swim` would win. An
  // auto-name-matched group never enters child_map, so a wrong guess there would be uncorrectable.
  const r = routeTitle('Ivy swim lesson', kids, {}, 'school');
  assert.equal(r.child_id, 'c1');
  assert.equal(r.type, 'school'); // the feed's type, NOT 'sport'
  assert.equal(routeTitle('Ivy Carter - Swim Team', kids, {}, 'school').type, 'school');
});

test('a NON-trip feed never guesses — a trip guess there fabricates a transport leg', () => {
  // Trip-typed hint targets alone only block the trip → non-trip direction. The reverse is just as
  // damaging and was live: a feed added as "Activity / Playdate" stores pd NULL, the sync route
  // writes `sub.pd || 'dropoff'`, and normalize() KEEPS that because the guessed type is a trip — so
  // the event arrives with an invented drop-off leg credited to the feed's parent in the report.
  const rules = { 'beginner swimming 5yr 15yr': 'c1' };
  const t = 'Beginner Swimming (5yr-15yr) - WCAC Sat';
  for (const nonTrip of ['activity', 'schoolevent', 'meal']) {
    assert.equal(routeTitle(t, kids, rules, nonTrip).type, nonTrip, `feed type ${nonTrip} must survive`);
  }
  // ...while a trip-typed feed still gets the guess.
  assert.equal(routeTitle(t, kids, rules, 'other').type, 'sport');
});

test('an EXPLICIT type is exempt from the non-trip gate — the user picked it', () => {
  const rules = { 'beginner swimming': { c: 'c1', t: '', s: 'Beginner Swimming', y: 'sport' } };
  assert.equal(routeTitle('Beginner Swimming - Sat', kids, rules, 'activity').type, 'sport');
});

test('guess:false suppresses the guess even when one would match', () => {
  // The sync route passes guess:false when the feed gave no SUMMARY, because the title it substitutes
  // is built from the FEED's own type label rather than anything the feed said.
  assert.equal(routeTitle('Swim Camp', kids, {}, 'sport').type, 'camp'); // guessing ON
  assert.equal(routeTitle('Swim Camp', kids, {}, 'sport', { guess: false }).type, 'sport');
  // Today every trip-typed label round-trips to its own type or to no match, so this guard changes no
  // current outcome — it stops a future label edit from silently re-typing title-less occurrences.
});

test('every class a child takes collapses to ONE key, so one assignment covers them all', () => {
  const a = routeTitle('Owen Carter - Beginner Swim', kids);
  const b = routeTitle('Owen Carter - Summer Day Camp', kids);
  assert.equal(a.key, b.key);
  assert.equal(b.title, 'Summer Day Camp');
});

test('case and whitespace variance produce the same key and child', () => {
  const a = routeTitle('Ivy Carter - Minnows (3yr-5yr)', kids);
  const b = routeTitle('  IVY   carter  -  Minnows (3yr-5yr) ', kids);
  assert.equal(b.key, a.key);
  assert.equal(b.child_id, 'c1');
});

test('no separator → the whole title is the segment and only the name word is stripped', () => {
  // An explicit, real fallbackType keeps this test — about segment/title splitting — insulated from
  // the from-title sentinel default.
  assert.deepEqual(routeTitle('Ivy swim lesson', kids, {}, 'sport'), {
    key: 'ivy swim lesson',
    seg: 'Ivy swim lesson',
    child_id: 'c1',
    title: 'swim lesson',
    type: 'sport', // the segment names a child, so no guess — the explicit fallback passes through
  });
});

test('an in-word hyphen and a clock time are not separators', () => {
  // "(3yr-5yr)" has no spaces around its dash; "9:00" has no space after its colon. The split must
  // land on the spaced dash in both cases.
  assert.equal(nameSegment('Minnows (3yr-5yr) - Pool'), 'Minnows (3yr-5yr)');
  assert.equal(nameSegment('Swim 9:00 AM - Pool'), 'Swim 9:00 AM');
  // A colon WITH a trailing space is a separator.
  assert.equal(nameSegment('Ivy: Minnows'), 'Ivy');
});

test('a title with no roster name goes to review, unchanged', () => {
  // An explicit, real (trip-typed) fallbackType — this test is about review-routing, not the
  // from-title sentinel, so it keeps its own subject regardless of that default.
  assert.deepEqual(routeTitle('Beginner Swim - Level 2', kids, {}, 'sport'), {
    key: 'beginner swim',
    seg: 'Beginner Swim',
    child_id: '',
    title: 'Beginner Swim - Level 2', // held events keep the full title for the review list
    type: 'sport', // no roster match, so the guess applies — 'swim' resolves to sport
  });
});

test('two children in one segment go to review — never guess on a custody record', () => {
  const r = routeTitle('Ivy & Owen - Family Swim', kids);
  assert.equal(r.child_id, '');
  assert.equal(r.title, 'Ivy & Owen - Family Swim');
});

test('a name outside the leading segment does NOT auto-match', () => {
  // Segment-only matching is what keeps a distance, a venue, or a coach's name from mis-routing.
  assert.equal(routeTitle('Owen Carter - Fun Run (Poison Ivy Trail)', kids).child_id, 'c2');
  assert.equal(routeTitle('Beginner Swim - with Coach Ivy', kids).child_id, '');
  assert.equal(routeTitle('Minnows - at Ivy League Pool', kids).child_id, '');
});

test('a rule-routed event is titled by its group, dropping the per-occurrence tail', () => {
  // The real rec1.com feed: the .ics carries no child name, so a rule does the routing. The leading
  // segment is the class; the tail is venue/day/time, all of which Kin already stores elsewhere.
  const rules = { 'minnows 3yr 5yr': 'c1' };
  const r = routeTitle('Minnows (3yr-5yr) - WCAC Sat 10:30 am', kids, rules);
  assert.equal(r.child_id, 'c1');
  assert.equal(r.title, 'Minnows (3yr-5yr)');
  assert.equal(r.seg, 'Minnows (3yr-5yr)'); // original case, for the review UI
});

test('a custom title on a rule overrides the group name', () => {
  const rules = { 'minnows 3yr 5yr': { c: 'c1', t: 'Swim lesson', s: 'Minnows (3yr-5yr)' } };
  const r = routeTitle('Minnows (3yr-5yr) - WCAC Sat 10:30 am', kids, rules);
  assert.equal(r.child_id, 'c1');
  assert.equal(r.title, 'Swim lesson');
});

test('a rule on a segment that NAMES a child still strips, rather than titling by the name', () => {
  // "Ivy & Owen" is ambiguous so it goes to review; once assigned, the title must not become
  // "Ivy & Owen" — the segment is a "who" prefix, so it is dropped like an auto-match.
  // Asserted through the {c,t,s} OBJECT shape the UI actually writes, not just the bare-string form:
  // an empty `t` must mean "recompute the default per event", or two different classes under one
  // name key would collapse to the same title.
  const objRule = { 'ivy owen': { c: 'c1', t: '', s: 'Ivy & Owen' } };
  assert.equal(routeTitle('Ivy & Owen - Family Swim', kids, objRule).title, 'Family Swim');
  assert.equal(routeTitle('Ivy & Owen - Water Polo', kids, objRule).title, 'Water Polo');
  // ...and the bare-string form behaves identically.
  const r = routeTitle('Ivy & Owen - Family Swim', kids, { 'ivy owen': 'c1' });
  assert.equal(r.child_id, 'c1');
  assert.equal(r.title, 'Family Swim');
});

test('two classes under one group key keep their own titles when no custom title is set', () => {
  const rules = { 'minnows 3yr 5yr': { c: 'c1', t: '', s: 'Minnows (3yr-5yr)' } };
  assert.equal(routeTitle('Minnows (3yr-5yr) - Sat 10:30', kids, rules).title, 'Minnows (3yr-5yr)');
  assert.equal(routeTitle('Minnows (3yr-5yr) - Sun 09:00', kids, rules).title, 'Minnows (3yr-5yr)');
});

test('a rule-routed title with no separator is left alone', () => {
  const r = routeTitle('Beginner Swim', kids, { 'beginner swim': 'c2' });
  assert.equal(r.child_id, 'c2');
  assert.equal(r.title, 'Beginner Swim');
});

test('a rule pointing at a child who is no longer active self-heals back to review', () => {
  // The roster passed in is active-only, so an archived assignment simply stops resolving instead
  // of failing validation and aborting the whole sync.
  const r = routeTitle('Beginner Swim - Level 2', kids, { 'beginner swim': 'c9' });
  assert.equal(r.child_id, '');
});

test('a pending key (value "") does not resolve to a child', () => {
  assert.equal(routeTitle('Beginner Swim - Level 2', kids, { 'beginner swim': '' }).child_id, '');
});

test('stripping never yields an empty title — events.title is NOT NULL', () => {
  assert.equal(stripName('Ivy', 'Ivy'), 'Ivy');
  assert.equal(stripName('Ivy - ', 'Ivy'), 'Ivy -'); // falls back to the (trimmed) original
  assert.equal(routeTitle('Ivy', kids).title, 'Ivy');
});

test('name matching is whole-word, never substring', () => {
  const mia = [{ id: 'c3', name: 'Mia' }];
  assert.equal(routeTitle('Miami Swim - Level 1', mia).child_id, '');
  assert.equal(hasName('Miami Swim', 'Mia'), false);
  assert.equal(hasName('Mia Swim', 'Mia'), true);
});

test('a multi-word roster name needs every word present', () => {
  const kid = [{ id: 'c4', name: 'Mary Jane' }];
  assert.equal(routeTitle('Mary Jane Smith - Ballet', kid).child_id, 'c4');
  assert.equal(routeTitle('Mary Smith - Ballet', kid).child_id, '');
});

test('a name containing regex metacharacters does not throw or over-match', () => {
  const kid = [{ id: 'c5', name: 'A.J.' }];
  assert.equal(routeTitle('AQJ - Soccer', kid).child_id, '');
  assert.equal(routeTitle('A.J. Carter - Soccer', kid).child_id, 'c5');
  assert.equal(stripName('A.J. swim', 'A.J.'), 'swim');
});

test('normKey collapses punctuation and keeps non-ASCII letters', () => {
  assert.equal(normKey('  Owen  CARTER -'), 'owen carter');
  assert.equal(normKey('José'), 'josé');
  assert.equal(normKey(null), '');
});

test('parseChildMap degrades to {} instead of throwing', () => {
  assert.deepEqual(parseChildMap(null), {});
  assert.deepEqual(parseChildMap(''), {});
  assert.deepEqual(parseChildMap('[]'), {});
  assert.deepEqual(parseChildMap('not json'), {});
  assert.deepEqual(parseChildMap('{"a":"c1"}'), { a: 'c1' });
  assert.deepEqual(parseChildMap({ a: 'c1' }), { a: 'c1' }); // already parsed (API body)
});

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

test("routeTitle with no fallbackType means from-title mode", () => {
  // The 4th param defaults to '', which USED to be inert and now IS the from-title sentinel.
  // Pinned here so the change is covered by a test that is about it, rather than being absorbed
  // into unrelated tests' incidental expectations.
  const swim = { 'minnows 3yr 5yr': { c: 'c1', s: 'Minnows (3yr-5yr)' } };
  assert.equal(routeTitle('Minnows (3yr-5yr) - WCAC', kids, swim).type, 'sport');
  const chess = { 'chess club': { c: 'c1', s: 'Chess Club' } };
  assert.equal(routeTitle('Chess Club - Room 4', kids, chess).type, 'other');
});

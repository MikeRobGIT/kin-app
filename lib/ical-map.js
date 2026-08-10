// Per-event child routing for a multi-child .ics feed. A class-portal feed carries BOTH kids and
// distinguishes them only by a name in the SUMMARY ("Ivy Carter - Minnows (3yr-5yr)"), so a
// subscription with NO pinned child (child_id NULL, v13) routes each occurrence to a child by that
// name. Pure — no db, no node deps — and deliberately NOT folded into lib/ical.js: that module
// imports the `ical.js` package, and components/Settings.js imports parseChildMap client-side, which
// would drag the whole RFC 5545 parser into the browser bundle. See docs/ical-subscriptions.md.
// (constants.js is fine to import here — it has no dependencies and Calendar.js already ships it.)
import { TYPES, isTrip } from './constants.js';

// Compare-form of a name or title fragment: lowercased, every run of non-letter/digit collapsed to a
// single space. "Owen  CARTER -" → "owen carter". \p{L}/\p{N} rather than \w so accented
// and non-Latin names survive intact.
export const normKey = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// The leading "who" segment of a title: everything before the first separator. A dash needs spaces
// on BOTH sides so an in-word hyphen can't split it ("Minnows (3yr-5yr)"), and a colon needs a
// trailing space so a clock time can't ("Swim 9:00 AM - Pool" must split at the dash, not the colon).
// No separator → the whole title is the segment.
const SEP = /\s[-–—|]\s|:\s/;
export function nameSegment(title) {
  const t = String(title ?? '').trim();
  const m = SEP.exec(t);
  return m ? t.slice(0, m.index) : t;
}

// True when EVERY word of `name` appears as a whole word in `text`. Word-level set membership, never
// substring — a child named Mia must not match "Miami Swim". Deliberately not a regex: a roster name
// is user data, so `\b` + interpolation would need escaping ("A.J." as a pattern matches "AQJ"), and
// JS \b is ASCII-defined, which misbehaves on accented names.
export function hasName(text, name) {
  const words = new Set(normKey(text).split(' ').filter(Boolean));
  const parts = normKey(name).split(' ').filter(Boolean);
  return parts.length > 0 && parts.every((w) => words.has(w));
}

// Escape a roster name for use inside a RegExp — a name is user data ("O'Brien", "A.").
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Drop the child's name from an imported title. With a separator the whole leading segment goes
// ("Ivy Carter - Minnows (3yr-5yr)" → "Minnows (3yr-5yr)"); without one only the name word does
// ("Ivy swim lesson" → "swim lesson"). If the name isn't in the leading segment the title is left
// ALONE — a rule keyed on a non-name segment ("beginner swim") must not eat it. Returns the ORIGINAL
// title whenever the strip would empty it: events.title is NOT NULL and validateEventFields rejects ''.
export function stripName(title, name) {
  const t = String(title ?? '').trim();
  const seg = nameSegment(t);
  if (!hasName(seg, name)) return t;
  const rest =
    seg.length < t.length
      ? t.slice(seg.length) // a separator existed → drop the whole leading segment
      : t.replace(new RegExp(`(^|\\P{L})${esc(String(name))}(?!\\p{L})`, 'iu'), '$1');
  return rest.replace(/^[\s\-–—|:]+/, '').trim() || t;
}

// Title keywords → an activity type, for a feed that mixes activities under one subscription.
//
// Ordering rules, in priority order:
//  1. TRIP-TYPED KEYS ONLY. A guess that crosses the trip/non-trip line silently rewrites the
//     involvement report: pd is forced by normalize(), so a non-trip feed guessing a trip type
//     invents a drop-off leg, and a trip feed guessing a non-trip type destroys one — neither
//     visible anywhere in the UI. Adding a caregiving hint means answering the pd question first.
//  2. Format beats the discipline it teaches — a week of camp is a camp, not a sport.
//  3. A superstring precedes its prefix ('after school' before 'school').
//  4. Whole-word only: variants are listed explicitly, never inferred. That is what keeps Campbell,
//     Campus, Gymnasium, Meeting and Media from matching camp/gym/meet/med.
//
// Deliberately absent: bare `gym` ("Basketball - Main Gym" is not gymnastics), `meet` (Parent
// Meeting), `med`/`dent` (Media Club, Denton Park), `clinic` (a medical clinic typed as Camp is a
// plausible, bad failure), `activity`/`morning` (both generic AND non-trip).
const TYPE_HINTS = [
  ['camp', 'camp'], ['camps', 'camp'],
  ['after school', 'daycare'], ['before school', 'daycare'],
  ['daycare', 'daycare'], ['preschool', 'daycare'], ['aftercare', 'daycare'],
  ['school', 'school'], ['kindergarten', 'school'],
  ['tutoring', 'tutor'], ['tutor', 'tutor'],
  ['therapy', 'therapy'], ['speech', 'therapy'], ['occupational', 'therapy'],
  ['gymnastics', 'gym'], ['gymnastic', 'gym'], ['tumbling', 'gym'], ['cheer', 'gym'],
  // `minnows`/`dolphins` are swim-level names from the real rec1.com feed — no English collision,
  // and they type the actual production titles without the user touching the select.
  ['swim', 'sport'], ['swimming', 'sport'], ['minnows', 'sport'], ['dolphins', 'sport'],
  ['soccer', 'sport'], ['basketball', 'sport'], ['baseball', 'sport'], ['softball', 'sport'],
  ['football', 'sport'], ['tennis', 'sport'], ['volleyball', 'sport'], ['lacrosse', 'sport'],
  ['karate', 'sport'], ['taekwondo', 'sport'], ['judo', 'sport'], ['wrestling', 'sport'],
  ['track', 'sport'], ['ballet', 'sport'], ['dance', 'sport'], ['skating', 'sport'],
];

// Filtered ONCE at load to hints whose key actually exists in TYPES. A hint naming a missing key
// would otherwise reach the imported row, fail validateEventFields with 'Invalid type', and make the
// sync route return 400 and abort the ENTIRE pull — every time, permanently, with a status message
// naming the wrong cause. TYPES is edited independently of this table, so the two drift by default —
// the filter is what makes that drift harmless rather than fatal.
export const HINTS = TYPE_HINTS.filter(([, key]) => !!TYPES[key]);

// Best-guess activity type for a title fragment, or null when nothing matches — never a fallback
// guess. Whole-word matching: the padded-space test means a hint only matches a complete word (or an
// exact multi-word run), so `camp` cannot hit "Campbell" and `gym` — were it ever added — could not
// hit "Gymnasium". First match wins, so HINTS order decides ties.
export function guessType(text) {
  const n = ` ${normKey(text)} `;
  for (const [hint, key] of HINTS) {
    if (n.includes(` ${hint} `)) return key;
  }
  return null;
}

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

// One child_map entry, normalized so callers never branch on its shape. An entry is either a bare
// child id (the original v13 form) or { c: child_id, t: custom title, s: the original-case leading
// segment, y: activity type }. `s` is recorded when the key is first seen so the review UI can show
// "Minnows (3yr-5yr)" instead of the normalized "minnows 3yr 5yr"; `t` and `y` are only set once the
// user renames or re-types the group ('' means "use the default", recomputed per event).
export function ruleEntry(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return {
      child_id: typeof v.c === 'string' ? v.c : '',
      title: typeof v.t === 'string' ? v.t : '',
      seg: typeof v.s === 'string' ? v.s : '',
      type: typeof v.y === 'string' ? v.y : '',
    };
  }
  return { child_id: typeof v === 'string' ? v : '', title: '', seg: '', type: '' };
}

// Route ONE feed occurrence to a child AND an activity type. `children` is the ACTIVE roster
// [{id,name}]; `rules` is the subscription's saved child_map; `fallbackType` is the feed's own type.
// Returns { key, seg, child_id, title, type }; child_id === '' means REVIEW — the caller must NOT
// import it. A saved rule beats a name match (the user's one-time decision is final). Zero matches,
// two-or-more matches, and a rule pointing at a child who is no longer active all fall back to
// review: a wrong child on a custody record is worse than an event that waits.
//
// `opts.guess` gates the keyword guess. The caller passes false when the feed supplied no SUMMARY:
// the sync route then synthesizes a title from the FEED's own type label, and guessing off that
// round-trips wrong — a `schoolevent` feed yields "School event", whose `school` hint is a different,
// TRIP-typed key, so a title-less occurrence would silently gain a transport leg.
//
// `fallbackType` defaults to '' — which is ALSO the from-title sentinel, not an inert "no type". The
// sync route always passes `sub.type` explicitly; a caller that omits this arg is opting INTO
// from-title guessing, not opting out of type resolution.
export function routeTitle(title, children, rules = {}, fallbackType = '', { guess = true } = {}) {
  const raw = String(title ?? '').trim();
  const seg = nameSegment(raw);
  const key = normKey(seg);
  const entry = ruleEntry(rules[key]);
  const ruled = children.find((c) => c.id === entry.child_id);
  // Match the leading segment ONLY — it is the registrant field. Scanning the whole title would
  // mis-route "Owen Carter - Fun Run (Poison Ivy Trail)" and "... - Beginner Swim w/ Coach Ivy".
  // ponytail: an activity-first feed ("Minnows - Ivy Carter") gets no auto-match and costs one
  // review assignment per class; widen to a whole-title fallback only if such a feed shows up.
  const hits = children.filter((c) => hasName(seg, c.name));
  const named = hits[0];

  // Guess from the SEGMENT, and only when:
  //  - the segment isn't a "who" prefix — the same condition the title branch below uses, so the type
  //    comes from `seg` exactly when the title does. A name segment carries no activity ("Ivy swim
  //    lesson" has no separator, so seg IS the whole title and `swim` would win), and a name-matched
  //    group never enters child_map, so it would have no review row to correct a wrong guess with.
  //  - the FEED's own type is trip-typed. Every hint targets a trip type, so guessing on a non-trip
  //    feed (say one added as "Activity / Playdate") flips trip-ness: pd is NULL on such a
  //    subscription, the sync route writes `sub.pd || 'dropoff'`, normalize() keeps it because the
  //    guessed type IS a trip, and the event arrives with a FABRICATED drop-off leg credited to the
  //    feed's parent in the involvement report. Restricting the hint targets alone does not prevent
  //    this — it only blocks the trip → non-trip direction.
  //  - OR the feed is in "from title" mode (fallbackType === ''), where guessing IS the point and
  //    there is no non-trip outcome to flip to: every hint target and the `other` resort are
  //    trip-typed, so pd stays coherent. A truthy fallbackType short-circuits both expressions, so
  //    every feed that has its own type behaves bit-identically to before.
  // An EXPLICIT `y` is exempt: the user picked it deliberately from a full list of types.
  const guessed =
    guess && !named && (fallbackType === '' || isTrip(fallbackType)) ? guessType(seg) : null;
  const type = entry.type || guessed || fallbackType || 'other';

  if (ruled) {
    // A rule matched. Which half of the title is the useful one depends on what the segment IS:
    //  - it names a child ("Ivy & Owen - Family Swim") → a "who" prefix, so drop it like an
    //    auto-match would and keep the rest.
    //  - it doesn't ("Minnows (3yr-5yr) - WCAC Sat 10:30 am") → the segment is the activity group
    //    the user named, and the tail is per-occurrence noise (venue/day/time — all of which Kin
    //    already stores as notes/date/time), so the segment becomes the title.
    // A custom title the user typed on the rule always wins over both.
    const auto = named ? stripName(raw, named.name) : seg;
    return { key, seg, child_id: ruled.id, title: entry.title || auto || raw, type };
  }
  if (hits.length === 1) {
    return { key, seg, child_id: named.id, title: stripName(raw, named.name), type };
  }
  return { key, seg, child_id: '', title: raw, type };
}

// Tolerant read of the child_map column / API field. Our own data, so a hand-edited or legacy row
// degrades to "no rules" rather than 500ing a sync. Safe to import from a client component.
export function parseChildMap(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  try {
    const m = JSON.parse(v || '{}');
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

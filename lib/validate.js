import { TYPE_KEYS, PD_KEYS, isTrip, takesLeg } from './constants.js';
import { PRESET_KEYS } from './schedule.js';

export const LIMITS = { title: 120, who: 120, notes: 500, label: 60, name: 40 };

// #rrggbb only.
export function isHexColor(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}

// YYYY-MM-DD that is a real calendar date (round-trips through Date).
export function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// YYYY-MM with a real month 01-12.
export function isMonth(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12;
}

// HH:MM with hours 00-23 and minutes 00-59.
export function isRealTime(s) {
  if (typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) return false;
  const [h, mi] = s.split(':').map(Number);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

// Shape/value validation independent of the DB. Returns an error string or null.
export function validateEventFields(b) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  const title = b.title == null ? '' : String(b.title).trim();
  if (!title) return 'Title is required';
  if (title.length > LIMITS.title) return 'Title too long';
  if (!TYPE_KEYS.includes(b.type)) return 'Invalid type';
  if (isTrip(b.type) && !PD_KEYS.includes(b.pd)) return 'Invalid trip kind';
  if (!isRealDate(b.date)) return 'Invalid date';
  if (!isRealTime(b.time)) return 'Invalid time';
  if ((b.who == null ? '' : String(b.who).trim()).length > LIMITS.who) return 'Who too long';
  if ((b.notes == null ? '' : String(b.notes).trim()).length > LIMITS.notes) return 'Notes too long';
  return null;
}

// Full validation including child/caregiver existence (needs the DB).
// `requireActive` (used on CREATE) also rejects an ARCHIVED child/parent, so a retired member
// can't be assigned to a NEW event. On EDIT it stays false: an existing event that already
// references a now-archived member must remain saveable (existence-only, no 400-trap).
export function validateEvent(b, db, { requireActive = false } = {}) {
  const err = validateEventFields(b);
  if (err) return err;
  const filter = requireActive ? ' AND archived = 0' : '';
  const child = db.prepare(`SELECT id FROM children WHERE id = ?${filter}`).get(b.child_id);
  if (!child) return requireActive ? 'Unknown or archived child' : 'Unknown child';
  if (b.caregiver_id) {
    const cg = db.prepare(`SELECT id FROM caregivers WHERE id = ?${filter}`).get(b.caregiver_id);
    if (!cg) return requireActive ? 'Unknown or archived caregiver' : 'Unknown caregiver';
  }
  if (b.pickup_caregiver_id) {
    const cg = db.prepare(`SELECT id FROM caregivers WHERE id = ?${filter}`).get(b.pickup_caregiver_id);
    if (!cg) return requireActive ? 'Unknown or archived pickup caregiver' : 'Unknown pickup caregiver';
  }
  return null;
}

// ---- Recurring events (manual "Repeat") ------------------------------------

export const REPEAT = { maxInterval: 8, maxCount: 366 };

// Shape/value validation for a manual recurrence rule. Used client-side to gate the preview;
// the server only ever receives the expanded concrete rows (each re-validated). Returns an
// error string or null.
export function validateRecurrence(r) {
  if (!r || typeof r !== 'object') return 'Invalid repeat';
  if (!Array.isArray(r.weekdays) || r.weekdays.length === 0) return 'Pick at least one weekday';
  if (!isRealDate(r.from)) return 'Invalid start date';
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > REPEAT.maxInterval)
    return 'Invalid interval';
  if (r.endType === 'count') {
    if (!Number.isInteger(r.count) || r.count < 1 || r.count > REPEAT.maxCount)
      return 'Invalid occurrence count';
  } else {
    if (!isRealDate(r.until)) return 'Invalid end date';
    if (r.until < r.from) return 'End date is before start date';
  }
  return null;
}

// ---- Lawyer share tokens ---------------------------------------------------

export const SHARE_DAYS = [7, 30, 90];

// Shape/value validation for a share-link creation request. Returns an error string or null.
export function validateShareInput(b) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  if (!isRealDate(b.date_from)) return 'Invalid start date';
  if (!isRealDate(b.date_to)) return 'Invalid end date';
  if (b.date_from > b.date_to) return 'Start date is after end date';
  if (!SHARE_DAYS.includes(b.days)) return 'Invalid expiry';
  if ((b.label == null ? '' : String(b.label).trim()).length > LIMITS.label) return 'Label too long';
  return null;
}

// ---- MCP agent tokens --------------------------------------------------------

// Shape/value validation for an MCP-token mint request. Label is optional. Returns an
// error string or null.
export function validateMcpTokenInput(b) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  if ((b.label == null ? '' : String(b.label).trim()).length > LIMITS.label) return 'Label too long';
  return null;
}

// ---- iCal calendar subscriptions -------------------------------------------

// A fetchable calendar URL: http(s) or webcal (rewritten to https server-side), length-capped.
export function isFeedUrl(s) {
  if (typeof s !== 'string') return false;
  const v = s.trim();
  return v.length > 0 && v.length <= 2048 && /^(https?|webcal):\/\//i.test(v);
}

// 'none' is an EVENT-level trip kind (a trip-typed activity that carried no leg this time) and is
// meaningless — dangerous, really — on a whole feed: sync stamps the subscription's pd on every row
// it imports, so a school feed set to 'none' would strip the leg off a year of real school runs. It
// is not reachable from Settings (which offers three options); this closes the raw-API path. The
// supported fix for one imported leg-less day is editing that event to No trip, which sync's
// add-only design will not clobber.
const NO_FEED_LEG = 'A feed cannot be leg-less — set No trip on the individual event';

// Shape/value validation for a saved subscription. `requireActive` (CREATE) rejects an archived
// child/parent — same active-gating as validateEvent, so a new subscription can't target a retired
// member. pd is only meaningful for a trip type and may be omitted (defaults to 'dropoff' on write).
// child_id is OPTIONAL since v13: null/'' means the feed carries more than one kid, and each event is
// routed to a child by the name in its title (lib/ical-map.js).
export function validateSubscription(b, db, { requireActive = false } = {}) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  if ((b.label == null ? '' : String(b.label).trim()).length > LIMITS.label) return 'Label too long';
  if (!isFeedUrl(b.url)) return 'Invalid calendar URL';
  // '' is the "from title" sentinel — the feed declares no activity and each event is typed from
  // its own title (lib/ical-map.js feedType). It is not a TYPE_KEYS member by design.
  if (b.type !== '' && !TYPE_KEYS.includes(b.type)) return 'Invalid type';
  if (takesLeg(b.type) && b.pd != null && b.pd !== '' && !PD_KEYS.includes(b.pd))
    return 'Invalid trip kind';
  if (b.pd === 'none') return NO_FEED_LEG;
  const filter = requireActive ? ' AND archived = 0' : '';
  if (b.child_id) {
    const child = db.prepare(`SELECT id FROM children WHERE id = ?${filter}`).get(b.child_id);
    if (!child) return requireActive ? 'Unknown or archived child' : 'Unknown child';
  }
  if (b.caregiver_id) {
    const cg = db.prepare(`SELECT id FROM caregivers WHERE id = ?${filter}`).get(b.caregiver_id);
    if (!cg) return requireActive ? 'Unknown or archived caregiver' : 'Unknown caregiver';
  }
  return null;
}

// A subscription's saved routing rules, keyed by normalized title segment. A value is either a bare
// child id ("" = seen but not yet assigned) or { c: child id, t: custom title, s: original-case
// segment }. This arrives straight off a request body and SQLite cannot FK into JSON, so it is
// bounded and existence-checked HERE — the same app-layer discipline as schedules.assignment (v5).
export const RULE_LIMITS = { keys: 100, key: 160 };

export function validateChildMap(map, db) {
  if (map == null) return null;
  if (typeof map !== 'object' || Array.isArray(map)) return 'Invalid calendar rules';
  const keys = Object.keys(map);
  if (keys.length > RULE_LIMITS.keys) return 'Too many calendar rules';
  // Existence-only, NOT active-gated. The client PUTs the whole map, so active-gating would make a
  // single stale assignment to a since-archived child reject every LATER save on that feed — with an
  // error naming the wrong rule. That is the same reason an event EDIT is existence-only while a
  // create is active-gated (see validateEvent). Safe here because routeTitle resolves rules against
  // the ACTIVE roster at sync time, so a rule pointing at an archived child simply stops matching and
  // its events return to the review list instead of being misfiled.
  const stmt = db.prepare('SELECT id FROM children WHERE id = ?');
  for (const k of keys) {
    if (!k || k.length > RULE_LIMITS.key) return 'Invalid calendar rule';
    const v = map[k];
    let child = v;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Reject unknown properties — the map is persisted verbatim by JSON.stringify.
      if (!Object.keys(v).every((p) => p === 'c' || p === 't' || p === 's' || p === 'y'))
        return 'Invalid calendar rule';
      child = v.c ?? '';
      if (typeof child !== 'string') return 'Invalid calendar rule';
      if (v.t != null && (typeof v.t !== 'string' || v.t.length > LIMITS.title)) return 'Invalid calendar rule';
      if (v.s != null && (typeof v.s !== 'string' || v.s.length > RULE_LIMITS.key)) return 'Invalid calendar rule';
      // `y` is the group's activity type; '' means "use the keyword guess / the feed's type". Strict
      // membership is right here (unlike `child`, which is existence-only) because the client picks
      // it from a select of live TYPES — a value outside TYPE_KEYS would fail validateEventFields at
      // import and abort the whole sync.
      if (v.y != null && (typeof v.y !== 'string' || (v.y !== '' && !TYPE_KEYS.includes(v.y))))
        return 'Invalid calendar rule';
    } else if (typeof v !== 'string') {
      return 'Invalid calendar rule';
    }
    if (child && !stmt.get(child)) return 'Unknown child';
  }
  return null;
}

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
  // pd must be coherent with the MERGED type in BOTH directions: a type that carries a leg may only
  // hold a real PD_KEYS value, and a type that carries none must hold no leg at all. Checking only
  // the first direction leaves a Sports → Bedtime switch free to keep its stale 'dropoff' — the exact
  // state this function's contract promises cannot reach the DB. The route also clears pd on the way
  // in; this is the backstop that makes that not something a future caller has to remember.
  if (takesLeg(b.type)) {
    if (b.pd != null && b.pd !== '' && !PD_KEYS.includes(b.pd)) return 'Invalid trip kind';
  } else if (b.pd != null && b.pd !== '') {
    return 'This activity has no drop-off or pickup leg';
  }
  if (b.pd === 'none') return NO_FEED_LEG;
  return validateChildMap(b.child_map, db);
}

// ---- Parent-time schedules -------------------------------------------------

// Shape/value validation for a base schedule, independent of the DB.
export function validateScheduleFields(b) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  if (!PRESET_KEYS.includes(b.preset_key)) return 'Invalid preset';
  if (!Number.isInteger(b.cycle_len) || b.cycle_len < 1 || b.cycle_len > 28)
    return 'Invalid cycle length';
  if (!Array.isArray(b.assignment)) return 'Invalid assignment';
  if (b.assignment.length !== b.cycle_len) return 'Assignment length must equal cycle length';
  if (!b.assignment.every((id) => typeof id === 'string' && id.trim().length > 0))
    return 'Invalid assignment';
  if (!isRealDate(b.anchor_date)) return 'Invalid anchor date';
  if (b.starts_on != null && b.starts_on !== '' && !isRealDate(b.starts_on))
    return 'Invalid start date';
  if (b.ends_on != null && b.ends_on !== '' && !isRealDate(b.ends_on)) return 'Invalid end date';
  if (b.starts_on && b.ends_on && b.starts_on > b.ends_on) return 'Start date is after end date';
  if ((b.label == null ? '' : String(b.label).trim()).length > LIMITS.label)
    return 'Label too long';
  return null;
}

// Full validation including caregiver existence for each assignment slot. Only ACTIVE parents
// may be written into a rotation — an archived parent left in an existing rotation still
// resolves at read time (parentOnDate), but the schedule can't be re-saved until it's rewritten
// with active parents (the ScheduleManager UI enforces this before the save).
export function validateSchedule(b, db) {
  const err = validateScheduleFields(b);
  if (err) return err;
  const known = new Set(
    db.prepare('SELECT id FROM caregivers WHERE archived = 0').all().map((r) => r.id)
  );
  for (const id of b.assignment) {
    if (!known.has(id)) return 'Unknown or archived caregiver in assignment';
  }
  return null;
}

// Shape/value validation for a date-range override.
export function validateOverrideFields(b) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  if (!b.caregiver_id || typeof b.caregiver_id !== 'string') return 'Parent is required';
  if (!isRealDate(b.date_from)) return 'Invalid start date';
  if (!isRealDate(b.date_to)) return 'Invalid end date';
  if (b.date_from > b.date_to) return 'Start date is after end date';
  if ((b.label == null ? '' : String(b.label).trim()).length > LIMITS.label)
    return 'Label too long';
  return null;
}

export function validateOverride(b, db) {
  const err = validateOverrideFields(b);
  if (err) return err;
  const cg = db.prepare('SELECT id FROM caregivers WHERE id = ? AND archived = 0').get(b.caregiver_id);
  if (!cg) return 'Unknown or archived caregiver';
  return null;
}

// ---- Family roster (children & parents) -----------------------------------

// A family member's create fields: a non-empty name (<= LIMITS.name) and a #rrggbb color.
// Shared by children and parents (identical shape). Kept as validateCaregiverFields for the
// existing parent-rename call sites + tests.
export function validateCaregiverFields(b) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  const name = b.name == null ? '' : String(b.name).trim();
  if (!name) return 'Name is required';
  if (name.length > LIMITS.name) return 'Name too long';
  if (!isHexColor(b.color)) return 'Invalid color';
  return null;
}

// True if another ACTIVE row in `table` already uses this name (case-insensitive), excluding
// `exceptId`. Guards the AI-parse name→id matching from two active members sharing a name.
// `table` is a fixed literal from the route ('children' | 'caregivers'), never user input.
export function activeNameTaken(db, table, name, exceptId = null) {
  const n = String(name).trim().toLowerCase();
  return db
    .prepare(`SELECT id, name FROM ${table} WHERE archived = 0`)
    .all()
    .some((r) => r.id !== exceptId && r.name.trim().toLowerCase() === n);
}

// CREATE a child/parent: full fields + no active-name collision.
export function validateFamilyCreate(b, db, table) {
  const err = validateCaregiverFields(b);
  if (err) return err;
  if (activeNameTaken(db, table, b.name)) return 'Name already in use';
  return null;
}

// UPDATE a child/parent: only the PROVIDED fields are checked, so an archive-only PUT
// ({ archived: 1 }) needs no name/color. `existing` is the current row ({ id, name, archived }).
// The active-name-uniqueness check runs on the row's FINAL name whenever it will be active —
// covering a rename AND an unarchive (an archive-only unarchive carries no name, so checking
// only `b.name` would let a re-created active twin collide when the original is restored).
export function validateFamilyUpdate(b, db, table, existing) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return 'Name is required';
    if (name.length > LIMITS.name) return 'Name too long';
  }
  if (b.color !== undefined && !isHexColor(b.color)) return 'Invalid color';
  if (
    b.archived !== undefined &&
    b.archived !== 0 && b.archived !== 1 && b.archived !== true && b.archived !== false
  )
    return 'Invalid archived flag';
  const willBeActive =
    b.archived === undefined ? existing.archived === 0 : !(b.archived === 1 || b.archived === true);
  const finalName = b.name !== undefined ? String(b.name).trim() : existing.name;
  if (willBeActive && activeNameTaken(db, table, finalName, existing.id)) return 'Name already in use';
  return null;
}

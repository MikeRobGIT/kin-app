// The MCP tool handlers. Each is a second caller of the SAME lib/ functions the HTTP
// routes use — so validation, audit snapshots, and transactional invariants hold for free.
// Handlers throw a friendly Error on bad input; lib/mcp-server.js turns that into an MCP
// isError result. No zod / no transport here → directly unit-testable.
import crypto from 'node:crypto';
import db from './db.js';
import { TYPES, TYPE_KEYS, PD_KEYS } from './constants.js';
import { parentOnDate, parseYmd, eachDay } from './schedule.js';
import { summarizeInvolvement } from './report.js';
import { validateEvent, isRealDate } from './validate.js';
import {
  createEvent, updateEventTx, deleteEventTx, createEventsBulk,
} from './event-writes.js';

export const MAX_RANGE_DAYS = 400;
const MS_PER_DAY = 86400000;

// Prepared once at module scope and reused (better-sqlite3 recompiles a statement on every
// db.prepare) — matches the pattern in lib/event-writes.js.
// get_context lists only ACTIVE members — an agent should log against the current roster.
const stmtChildren = db.prepare('SELECT id, name FROM children WHERE archived = 0 ORDER BY sort');
const stmtCaregivers = db.prepare('SELECT id, name FROM caregivers WHERE archived = 0 ORDER BY sort');
// The report resolves names for ALL parents (incl. archived) so historical trips still attribute.
const stmtCaregiversFull = db.prepare('SELECT * FROM caregivers ORDER BY sort');
const stmtSchedules = db.prepare('SELECT * FROM schedules ORDER BY created_at');
const stmtOverrides = db.prepare('SELECT * FROM schedule_overrides ORDER BY date_from');
const stmtEventsInRange = db.prepare('SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date, time');
const stmtEventExists = db.prepare('SELECT id FROM events WHERE id = ?');

function assertRange(from, to) {
  if (!isRealDate(from) || !isRealDate(to)) throw new Error('Invalid date range (use YYYY-MM-DD for both from and to)');
  if (from > to) throw new Error('Start date is after end date');
  const days = Math.round((parseYmd(to) - parseYmd(from)) / MS_PER_DAY) + 1;
  if (days > MAX_RANGE_DAYS) throw new Error(`Range too large — request ${MAX_RANGE_DAYS} days or fewer`);
}

function loadSchedules() {
  return { schedules: stmtSchedules.all(), overrides: stmtOverrides.all() };
}

// --- reads -----------------------------------------------------------------

export function getContext() {
  return {
    children: stmtChildren.all(),
    caregivers: stmtCaregivers.all(),
    types: TYPE_KEYS.map((key) => ({ key, label: TYPES[key].label, trip: !!TYPES[key].trip })),
    pdKinds: PD_KEYS,
  };
}

export function listEvents({ from, to } = {}) {
  assertRange(from, to);
  const events = stmtEventsInRange.all(from, to);
  const { schedules, overrides } = loadSchedules();
  const onDuty = {};
  eachDay(from, to, (ds) => {
    onDuty[ds] = parentOnDate(ds, schedules, overrides);
  });
  return { from, to, events, onDuty };
}

export function involvementReport({ from, to } = {}) {
  assertRange(from, to);
  const events = stmtEventsInRange.all(from, to);
  const caregivers = stmtCaregiversFull.all();
  return { from, to, summary: summarizeInvolvement(events, caregivers) };
}

// --- event writes (reuse the audited transactional helpers) ----------------

export function logEvent(fields) {
  const err = validateEvent(fields, db, { requireActive: true });
  if (err) throw new Error(err);
  return createEvent(fields);
}

export function updateEvent({ id, ...fields } = {}) {
  const existing = stmtEventExists.get(id);
  if (!existing) throw new Error('Unknown event');
  const err = validateEvent(fields, db);
  if (err) throw new Error(err);
  return updateEventTx(id, fields);
}

export function deleteEvent({ id } = {}) {
  const ok = deleteEventTx(id);
  if (!ok) throw new Error('Unknown event');
  return { deleted: true, id };
}

const MAX_BULK = 366; // mirrors app/api/events/bulk/route.js

export function logEventsBulk({ events, series } = {}) {
  if (!Array.isArray(events) || events.length === 0) throw new Error('No entries to create');
  if (events.length > MAX_BULK) throw new Error(`Too many entries (max ${MAX_BULK})`);
  for (let i = 0; i < events.length; i++) {
    const err = validateEvent(events[i], db, { requireActive: true });
    if (err) throw new Error(`${err} (entry ${i})`);
  }
  const series_id = series === true ? 's' + crypto.randomUUID().slice(0, 12) : null;
  const created = createEventsBulk(events, series_id);
  return { created, series_id };
}

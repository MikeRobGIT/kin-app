import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../lib/migrate.js';
import {
  validateFamilyCreate,
  validateFamilyUpdate,
  validateEvent,
  validateSchedule,
  validateOverride,
} from '../lib/validate.js';

// Real in-memory DB reaching the archived column (migration v11), seeded like production.
function db() {
  const d = new Database(':memory:');
  runMigrations(d);
  d.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Ivy','#c8553d',0)").run();
  d.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c2','Owen','#3a6b5e',1)").run();
  d.prepare("INSERT INTO caregivers (id,name,color,sort) VALUES ('g1','Dad','#2d6a9f',0)").run();
  d.prepare("INSERT INTO caregivers (id,name,color,sort) VALUES ('g2','Mom','#b5396b',1)").run();
  return d;
}
const archive = (d, table, id) => d.prepare(`UPDATE ${table} SET archived=1 WHERE id=?`).run(id);
const ev = (o = {}) => ({
  title: 'School', type: 'school', child_id: 'c1', caregiver_id: 'g1',
  pd: 'dropoff', date: '2026-06-13', time: '08:00', who: '', notes: '', ...o,
});

test('validateFamilyCreate: fields + no active-name collision (case-insensitive)', () => {
  const d = db();
  assert.equal(validateFamilyCreate({ name: 'Nadia', color: '#123456' }, d, 'children'), null);
  assert.equal(validateFamilyCreate({ name: '', color: '#123456' }, d, 'children'), 'Name is required');
  assert.equal(validateFamilyCreate({ name: 'Nadia', color: 'red' }, d, 'children'), 'Invalid color');
  assert.equal(validateFamilyCreate({ name: 'ivy', color: '#123456' }, d, 'children'), 'Name already in use');
});

test('an archived member frees its name for reuse by an active one', () => {
  const d = db();
  archive(d, 'children', 'c1'); // Ivy archived
  assert.equal(validateFamilyCreate({ name: 'Ivy', color: '#123456' }, d, 'children'), null);
});

test('validateFamilyUpdate: partial fields; archive-only needs no name/color', () => {
  const d = db();
  const c1 = { id: 'c1', name: 'Ivy', archived: 0 };
  assert.equal(validateFamilyUpdate({ archived: 1 }, d, 'children', c1), null);
  assert.equal(validateFamilyUpdate({ name: 'Ivo' }, d, 'children', c1), null); // rename self ok
  assert.equal(validateFamilyUpdate({ name: 'Owen' }, d, 'children', c1), 'Name already in use');
  assert.equal(validateFamilyUpdate({ color: 'nope' }, d, 'children', c1), 'Invalid color');
  assert.equal(validateFamilyUpdate({ archived: 2 }, d, 'children', c1), 'Invalid archived flag');
});

test('unarchiving a member whose name collides with an active one is rejected', () => {
  const d = db();
  // Archive Ivy(c1), then create a new active child also named 'Ivy' (allowed — c1 inactive).
  d.prepare("UPDATE children SET archived=1 WHERE id='c1'").run();
  d.prepare("INSERT INTO children (id,name,color,sort,archived) VALUES ('c3','Ivy','#111111',2,0)").run();
  const c1 = { id: 'c1', name: 'Ivy', archived: 1 };
  // Unarchiving c1 (no name in the body) must still be blocked — two active 'Ivy' would misfile.
  assert.equal(validateFamilyUpdate({ archived: 0 }, d, 'children', c1), 'Name already in use');
  // Once the active twin is archived, restoring c1 is fine.
  d.prepare("UPDATE children SET archived=1 WHERE id='c3'").run();
  assert.equal(validateFamilyUpdate({ archived: 0 }, d, 'children', c1), null);
});

test('validateEvent requireActive rejects an archived child/caregiver on CREATE', () => {
  const d = db();
  archive(d, 'caregivers', 'g2');
  archive(d, 'children', 'c2');
  assert.equal(validateEvent(ev(), d, { requireActive: true }), null); // c1/g1 active
  assert.equal(
    validateEvent(ev({ child_id: 'c2' }), d, { requireActive: true }),
    'Unknown or archived child'
  );
  assert.equal(
    validateEvent(ev({ caregiver_id: 'g2' }), d, { requireActive: true }),
    'Unknown or archived caregiver'
  );
  assert.equal(
    validateEvent(ev({ pd: 'both', pickup_caregiver_id: 'g2' }), d, { requireActive: true }),
    'Unknown or archived pickup caregiver'
  );
});

test('validateEvent on EDIT (existence-only) still accepts an archived member', () => {
  const d = db();
  archive(d, 'caregivers', 'g2');
  archive(d, 'children', 'c2');
  // No requireActive → an old event referencing an archived member must remain saveable.
  assert.equal(validateEvent(ev({ child_id: 'c2', caregiver_id: 'g2' }), d), null);
});

test('validateSchedule / validateOverride reject an archived parent', () => {
  const d = db();
  archive(d, 'caregivers', 'g2');
  const sched = {
    label: 'x', preset_key: 'week_on_off', cycle_len: 2, assignment: ['g1', 'g2'],
    anchor_date: '2026-01-05', starts_on: null, ends_on: null,
  };
  assert.equal(validateSchedule(sched, d), 'Unknown or archived caregiver in assignment');
  assert.equal(validateSchedule({ ...sched, assignment: ['g1', 'g1'] }, d), null);
  assert.equal(
    validateOverride({ caregiver_id: 'g2', date_from: '2026-06-01', date_to: '2026-06-02' }, d),
    'Unknown or archived caregiver'
  );
  assert.equal(
    validateOverride({ caregiver_id: 'g1', date_from: '2026-06-01', date_to: '2026-06-02' }, d),
    null
  );
});

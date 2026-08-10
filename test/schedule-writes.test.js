import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let db, sw, updateCaregiver;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sw-'));
  ({ default: db } = await import('../lib/db.js'));
  sw = await import('../lib/schedule-writes.js');
  ({ updateCaregiver } = await import('../lib/family-writes.js'));
});

const sched = () => ({
  label: 'School year',
  preset_key: 'week_on_off',
  cycle_len: 4,
  assignment: ['g1', 'g1', 'g2', 'g2'],
  anchor_date: '2026-01-05',
  starts_on: null,
  ends_on: null,
});
const ov = () => ({
  caregiver_id: 'g1',
  date_from: '2026-11-26',
  date_to: '2026-11-29',
  label: 'Thanksgiving',
});
const auditFor = (ref) =>
  db
    .prepare('SELECT kind, action, snapshot FROM schedule_audit WHERE ref_id = ? ORDER BY id')
    .all(ref);

test('createSchedule persists the row (assignment as JSON) + a create audit', () => {
  const row = sw.createSchedule(sched());
  assert.equal(row.preset_key, 'week_on_off');
  assert.deepEqual(JSON.parse(row.assignment), ['g1', 'g1', 'g2', 'g2']);
  const a = auditFor(row.id);
  assert.deepEqual(a.map((x) => x.action), ['create']);
  assert.equal(a[0].kind, 'schedule');
});

test('updateScheduleTx sets updated_at and logs update', () => {
  const row = sw.createSchedule(sched());
  const after = sw.updateScheduleTx(row.id, { ...sched(), label: 'Summer' });
  assert.equal(after.label, 'Summer');
  assert.ok(after.updated_at);
  assert.deepEqual(auditFor(row.id).map((x) => x.action), ['create', 'update']);
});

test('deleteScheduleTx removes the row but keeps a delete snapshot', () => {
  const row = sw.createSchedule(sched());
  assert.equal(sw.deleteScheduleTx(row.id), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE id = ?').get(row.id).n, 0);
  const a = auditFor(row.id);
  assert.deepEqual(a.map((x) => x.action), ['create', 'delete']);
  assert.equal(JSON.parse(a[1].snapshot).label, 'School year');
});

test('deleting a missing schedule returns false', () => {
  assert.equal(sw.deleteScheduleTx('nope'), false);
});

test('override create/update/delete audit under kind=override', () => {
  const row = sw.createOverride(ov());
  assert.equal(row.label, 'Thanksgiving');
  sw.updateOverrideTx(row.id, { ...ov(), caregiver_id: 'g2' });
  assert.equal(sw.deleteOverrideTx(row.id), true);
  const a = auditFor(row.id);
  assert.deepEqual(a.map((x) => x.action), ['create', 'update', 'delete']);
  assert.ok(a.every((x) => x.kind === 'override'));
});

test('updateCaregiver renames/recolors and keeps the id stable', () => {
  const after = updateCaregiver('g1', { name: 'Papa', color: '#123456' });
  assert.equal(after.id, 'g1');
  assert.equal(after.name, 'Papa');
  assert.equal(after.color, '#123456');
});

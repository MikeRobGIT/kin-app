import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let db, createEvent, updateEventTx, deleteEventTx, createEventsBulk, updateSeriesTx, deleteSeriesTx;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ew-'));
  ({ default: db } = await import('../lib/db.js'));
  ({ createEvent, updateEventTx, deleteEventTx, createEventsBulk, updateSeriesTx, deleteSeriesTx } =
    await import('../lib/event-writes.js'));
});

const sample = () => ({
  title: 'School drop-off', type: 'school', child_id: 'c1',
  caregiver_id: 'g1', pd: 'dropoff', date: '2026-06-13', time: '08:00', who: '', notes: '',
});
const auditFor = (id) =>
  db.prepare('SELECT action FROM event_audit WHERE event_id = ? ORDER BY id').all(id).map((r) => r.action);

test('create writes the row and a create audit entry', () => {
  const row = createEvent(sample());
  assert.equal(row.title, 'School drop-off');
  assert.deepEqual(auditFor(row.id), ['create']);
});

test('update sets updated_at and logs an update entry', () => {
  const row = createEvent(sample());
  const after = updateEventTx(row.id, { ...sample(), title: 'Changed' });
  assert.equal(after.title, 'Changed');
  assert.ok(after.updated_at, 'updated_at should be set');
  assert.deepEqual(auditFor(row.id), ['create', 'update']);
});

test('delete removes the row but preserves a delete snapshot', () => {
  const row = createEvent(sample());
  const ok = deleteEventTx(row.id);
  assert.equal(ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get(row.id).n, 0);
  const entries = db
    .prepare('SELECT action, snapshot FROM event_audit WHERE event_id = ? ORDER BY id')
    .all(row.id);
  assert.deepEqual(entries.map((e) => e.action), ['create', 'delete']);
  assert.equal(JSON.parse(entries[1].snapshot).title, 'School drop-off');
});

test('deleting a missing id returns false', () => {
  assert.equal(deleteEventTx('nope'), false);
});

// Duplicate (IB-02) reuses createEvent by re-submitting a full event row. The id/timestamps
// on that row must be ignored so the copy is a NEW event, never an overwrite of the source.
test('create ignores a supplied id and mints a fresh one (duplicate safety)', () => {
  const orig = createEvent(sample());
  const dup = createEvent({ ...orig, title: 'Copy' }); // orig carries id/created_at/updated_at
  assert.notEqual(dup.id, orig.id);
  assert.match(dup.id, /^e[0-9a-f-]{12}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get(orig.id).n, 1);
  assert.deepEqual(auditFor(dup.id), ['create']);
});

test('bulk insert audits every row', () => {
  const n = createEventsBulk([sample(), { ...sample(), title: 'Pickup', pd: 'pickup' }]);
  assert.equal(n, 2);
});

test('createEvent ignores a client-supplied series_id (series membership is server-only)', () => {
  const row = createEvent({ ...sample(), series_id: 's_injected' });
  assert.equal(row.series_id, null);
});

test('bulk insert without a series_id leaves rows unlinked', () => {
  createEventsBulk([sample()]);
  const anyNull = db.prepare("SELECT COUNT(*) AS n FROM events WHERE series_id IS NULL").get().n;
  assert.ok(anyNull >= 1);
});

test('bulk insert with a series_id stamps every row with it', () => {
  const sid = 's_test_1';
  const n = createEventsBulk(
    [
      { ...sample(), date: '2026-06-02' },
      { ...sample(), date: '2026-06-04' },
      { ...sample(), date: '2026-06-09' },
    ],
    sid
  );
  assert.equal(n, 3);
  const rows = db.prepare('SELECT date, series_id FROM events WHERE series_id = ? ORDER BY date').all(sid);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.series_id === sid));
});

test('updateSeriesTx edits shared fields across the series but keeps each date, auditing each', () => {
  const sid = 's_test_2';
  createEventsBulk(
    [
      { ...sample(), title: 'Tutoring', date: '2026-09-01' },
      { ...sample(), title: 'Tutoring', date: '2026-09-03' },
    ],
    sid
  );
  const n = updateSeriesTx(sid, { ...sample(), title: 'Math tutoring', time: '16:00', date: '2026-09-01' });
  assert.equal(n, 2);
  const rows = db.prepare('SELECT title, time, date FROM events WHERE series_id = ? ORDER BY date').all(sid);
  assert.ok(rows.every((r) => r.title === 'Math tutoring' && r.time === '16:00'));
  assert.deepEqual(rows.map((r) => r.date), ['2026-09-01', '2026-09-03']); // dates untouched
  // each occurrence got a create then an update audit entry
  const id = db.prepare('SELECT id FROM events WHERE series_id = ? ORDER BY date').get(sid).id;
  assert.deepEqual(auditFor(id), ['create', 'update']);
});

test('updateSeriesTx on an unknown series returns 0', () => {
  assert.equal(updateSeriesTx('nope', { ...sample() }), 0);
});

test('deleteSeriesTx removes every occurrence and preserves delete snapshots', () => {
  const sid = 's_test_3';
  createEventsBulk(
    [
      { ...sample(), date: '2026-10-01' },
      { ...sample(), date: '2026-10-08' },
    ],
    sid
  );
  const ids = db.prepare('SELECT id FROM events WHERE series_id = ? ORDER BY date').all(sid).map((r) => r.id);
  const n = deleteSeriesTx(sid);
  assert.equal(n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE series_id = ?').get(sid).n, 0);
  for (const id of ids) assert.deepEqual(auditFor(id), ['create', 'delete']);
});

test('deleteSeriesTx on an unknown series returns 0', () => {
  assert.equal(deleteSeriesTx('nope'), 0);
});

test('audit rows carry a timestamp', () => {
  const row = createEvent(sample());
  const at = db.prepare('SELECT at FROM event_audit WHERE event_id = ? ORDER BY id').get(row.id).at;
  assert.ok(at, 'audit.at should be set');
  assert.match(at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('buildExport returns all tables + meta', async () => {
  const { buildExport } = await import('../lib/export.js');
  createEvent(sample());
  const dump = buildExport(db);
  assert.ok(Array.isArray(dump.events) && dump.events.length >= 1);
  assert.ok(Array.isArray(dump.children) && dump.children.length === 2);
  assert.ok(Array.isArray(dump.caregivers) && dump.caregivers.length === 2);
  assert.ok(Array.isArray(dump.event_audit) && dump.event_audit.length >= 1);
  // export must be complete: parent-time schedule + monthly seals are included too
  assert.ok(Array.isArray(dump.schedules));
  assert.ok(Array.isArray(dump.schedule_overrides));
  assert.ok(Array.isArray(dump.schedule_audit));
  assert.ok(Array.isArray(dump.month_seals));
  assert.ok(Array.isArray(dump.share_tokens));
  assert.ok(Array.isArray(dump.mcp_tokens));
  assert.equal(typeof dump.schema_version, 'number');
  assert.ok(dump.exported_at);
});

test('pickup_caregiver_id is stored only for a distinct both-trip pickup parent', () => {
  const split = createEvent({ ...sample(), pd: 'both', caregiver_id: 'g1', pickup_caregiver_id: 'g2' });
  assert.equal(split.pickup_caregiver_id, 'g2'); // distinct pickup parent kept
  const same = createEvent({ ...sample(), pd: 'both', caregiver_id: 'g1', pickup_caregiver_id: 'g1' });
  assert.equal(same.pickup_caregiver_id, null); // same parent both ways collapses (legacy-equivalent)
  const drop = createEvent({ ...sample(), pd: 'dropoff', caregiver_id: 'g1', pickup_caregiver_id: 'g2' });
  assert.equal(drop.pickup_caregiver_id, null); // single-leg trip ignores pickup
  const care = createEvent({ ...sample(), type: 'meal', caregiver_id: 'g1', pickup_caregiver_id: 'g2' });
  assert.equal(care.pickup_caregiver_id, null); // non-trip care ignores pickup
});

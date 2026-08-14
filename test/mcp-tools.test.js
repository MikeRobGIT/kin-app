import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let db, T;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mcp-'));
  ({ default: db } = await import('../lib/db.js'));
  T = await import('../lib/mcp-tools.js');
});

const ev = (o = {}) => ({
  title: 'School drop-off', type: 'school', child_id: 'c1', caregiver_id: 'g1',
  pd: 'dropoff', date: '2026-06-13', time: '08:00', who: '', notes: '', ...o,
});

test('getContext exposes the seeded children, caregivers, types, and pd kinds', () => {
  const c = T.getContext();
  assert.deepEqual(c.children.map((x) => x.id), ['c1', 'c2']);
  assert.deepEqual(c.caregivers.map((x) => x.id), ['g1', 'g2']);
  assert.ok(c.types.find((t) => t.key === 'school' && t.trip === true));
  assert.deepEqual(c.pdKinds, ['dropoff', 'pickup', 'both', 'none']);
});

test('logEvent creates a row and one create audit entry', () => {
  const row = T.logEvent(ev());
  assert.match(row.id, /^e[0-9a-f-]{12}$/);
  const audit = db.prepare('SELECT action FROM event_audit WHERE event_id = ?').all(row.id).map((r) => r.action);
  assert.deepEqual(audit, ['create']);
});

test('logEvent throws the validator message on an unknown child', () => {
  // logEvent is a CREATE path → requireActive, so the message names the archived-or-unknown case.
  assert.throws(() => T.logEvent(ev({ child_id: 'nope' })), /Unknown or archived child/);
});

test('updateEvent throws on a missing id and does not write', () => {
  assert.throws(() => T.updateEvent({ id: 'missing', ...ev({ title: 'X' }) }), /Unknown event/);
});

test('updateEvent edits an existing row', () => {
  const row = T.logEvent(ev());
  const after = T.updateEvent({ id: row.id, ...ev({ title: 'Changed' }) });
  assert.equal(after.title, 'Changed');
});

test('deleteEvent removes a row; deleting a missing id throws', () => {
  const row = T.logEvent(ev());
  assert.deepEqual(T.deleteEvent({ id: row.id }), { deleted: true, id: row.id });
  assert.throws(() => T.deleteEvent({ id: row.id }), /Unknown event/);
});

test('logEventsBulk is all-or-nothing on a bad row', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  assert.throws(() => T.logEventsBulk({ events: [ev(), ev({ type: 'bogus' })] }), /Invalid type/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, before);
});

test('logEventsBulk with series=true links the rows under one server-minted id', () => {
  const r = T.logEventsBulk({ events: [ev({ date: '2026-07-01' }), ev({ date: '2026-07-02' })], series: true });
  assert.equal(r.created, 2);
  assert.match(r.series_id, /^s[0-9a-f-]{12}$/);
});

test('listEvents returns in-range events and an onDuty map', () => {
  T.logEvent(ev({ date: '2026-08-10', title: 'InRange' }));
  const out = T.listEvents({ from: '2026-08-01', to: '2026-08-31' });
  assert.ok(out.events.some((e) => e.title === 'InRange'));
  assert.ok(Object.prototype.hasOwnProperty.call(out.onDuty, '2026-08-10'));
});

test('listEvents rejects a bad or oversized range', () => {
  assert.throws(() => T.listEvents({ from: 'nope', to: '2026-08-31' }), /Invalid date range/);
  assert.throws(() => T.listEvents({ from: '2026-01-01', to: '2030-01-01' }), /Range too large/);
});

test('involvementReport summarizes per-caregiver counts', () => {
  const out = T.involvementReport({ from: '2026-06-01', to: '2026-06-30' });
  assert.equal(typeof out.summary.grand, 'number');
});

test('getContext lists only ACTIVE members and logEvent rejects an archived one', () => {
  db.prepare("UPDATE caregivers SET archived=1 WHERE id='g2'").run();
  db.prepare("UPDATE children SET archived=1 WHERE id='c2'").run();
  const c = T.getContext();
  assert.deepEqual(c.children.map((x) => x.id), ['c1']); // c2 archived → hidden
  assert.deepEqual(c.caregivers.map((x) => x.id), ['g1']); // g2 archived → hidden
  assert.throws(() => T.logEvent(ev({ child_id: 'c2' })), /Unknown or archived child/);
  assert.throws(() => T.logEvent(ev({ caregiver_id: 'g2' })), /Unknown or archived caregiver/);
  // un-archive to avoid leaking state into later-added tests
  db.prepare("UPDATE caregivers SET archived=0 WHERE id='g2'").run();
  db.prepare("UPDATE children SET archived=0 WHERE id='c2'").run();
});

test('an archived caregiver with historical events is still credited + named in the report', () => {
  // The core "history stays intact" guarantee: archive ≠ delete, so past trips still attribute.
  T.logEvent(ev({ date: '2026-09-10', caregiver_id: 'g2', title: 'Legacy trip' })); // g2 active here
  db.prepare("UPDATE caregivers SET archived=1 WHERE id='g2'").run();
  const out = T.involvementReport({ from: '2026-09-01', to: '2026-09-30' });
  assert.ok(out.summary.buckets.g2, 'archived g2 still has a bucket');
  assert.ok(out.summary.order.includes('g2'), 'archived g2 still appears in the report order');
  db.prepare("UPDATE caregivers SET archived=0 WHERE id='g2'").run();
});

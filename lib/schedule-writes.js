import crypto from 'node:crypto';
import db from './db.js';

// Mirrors lib/event-writes.js: every write is a transaction that also appends an
// append-only schedule_audit snapshot. `assignment` is stored as a JSON string.

function normSchedule(b) {
  return {
    label: (b.label || '').trim(),
    preset_key: b.preset_key,
    cycle_len: b.cycle_len,
    assignment: JSON.stringify(b.assignment),
    anchor_date: b.anchor_date,
    starts_on: b.starts_on || null,
    ends_on: b.ends_on || null,
  };
}
function normOverride(b) {
  return {
    caregiver_id: b.caregiver_id,
    date_from: b.date_from,
    date_to: b.date_to,
    label: (b.label || '').trim(),
  };
}

const insSchedule = db.prepare(
  `INSERT INTO schedules (id,label,preset_key,cycle_len,assignment,anchor_date,starts_on,ends_on)
   VALUES (@id,@label,@preset_key,@cycle_len,@assignment,@anchor_date,@starts_on,@ends_on)`
);
const updSchedule = db.prepare(
  `UPDATE schedules SET label=@label, preset_key=@preset_key, cycle_len=@cycle_len,
     assignment=@assignment, anchor_date=@anchor_date, starts_on=@starts_on, ends_on=@ends_on,
     updated_at=datetime('now') WHERE id=@id`
);
const getSchedule = db.prepare('SELECT * FROM schedules WHERE id = ?');
const delSchedule = db.prepare('DELETE FROM schedules WHERE id = ?');

const insOverride = db.prepare(
  `INSERT INTO schedule_overrides (id,caregiver_id,date_from,date_to,label)
   VALUES (@id,@caregiver_id,@date_from,@date_to,@label)`
);
const updOverride = db.prepare(
  `UPDATE schedule_overrides SET caregiver_id=@caregiver_id, date_from=@date_from,
     date_to=@date_to, label=@label, updated_at=datetime('now') WHERE id=@id`
);
const getOverride = db.prepare('SELECT * FROM schedule_overrides WHERE id = ?');
const delOverride = db.prepare('DELETE FROM schedule_overrides WHERE id = ?');

const insAudit = db.prepare(
  'INSERT INTO schedule_audit (kind, ref_id, action, snapshot) VALUES (@kind,@ref_id,@action,@snapshot)'
);
function audit(kind, ref_id, action, row) {
  insAudit.run({ kind, ref_id, action, snapshot: JSON.stringify(row) });
}
const sid = () => 's' + crypto.randomUUID().slice(0, 12);
const oid = () => 'o' + crypto.randomUUID().slice(0, 12);

export const createSchedule = db.transaction((b) => {
  const id = sid();
  insSchedule.run({ id, ...normSchedule(b) });
  const row = getSchedule.get(id);
  audit('schedule', id, 'create', row);
  return row;
});

// Caller must ensure the id exists (the PUT route does a 404 pre-check).
export const updateScheduleTx = db.transaction((id, b) => {
  updSchedule.run({ id, ...normSchedule(b) });
  const row = getSchedule.get(id);
  audit('schedule', id, 'update', row);
  return row;
});

export const deleteScheduleTx = db.transaction((id) => {
  const row = getSchedule.get(id);
  if (!row) return false;
  audit('schedule', id, 'delete', row); // snapshot BEFORE the row leaves the table
  delSchedule.run(id);
  return true;
});

export const createOverride = db.transaction((b) => {
  const id = oid();
  insOverride.run({ id, ...normOverride(b) });
  const row = getOverride.get(id);
  audit('override', id, 'create', row);
  return row;
});

export const updateOverrideTx = db.transaction((id, b) => {
  updOverride.run({ id, ...normOverride(b) });
  const row = getOverride.get(id);
  audit('override', id, 'update', row);
  return row;
});

export const deleteOverrideTx = db.transaction((id) => {
  const row = getOverride.get(id);
  if (!row) return false;
  audit('override', id, 'delete', row);
  delOverride.run(id);
  return true;
});

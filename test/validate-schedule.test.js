import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../lib/migrate.js';
import {
  validateScheduleFields,
  validateSchedule,
  validateOverrideFields,
  validateOverride,
  validateCaregiverFields,
  isHexColor,
} from '../lib/validate.js';

function db() {
  const d = new Database(':memory:');
  runMigrations(d);
  d.prepare("INSERT INTO caregivers (id,name,color,sort) VALUES ('g1','Dad','#2d6a9f',0)").run();
  d.prepare("INSERT INTO caregivers (id,name,color,sort) VALUES ('g2','Mom','#b5396b',1)").run();
  return d;
}

const okSchedule = {
  label: 'School year',
  preset_key: 'week_on_off',
  cycle_len: 4,
  assignment: ['g1', 'g1', 'g2', 'g2'],
  anchor_date: '2026-01-05',
  starts_on: null,
  ends_on: null,
};

test('validateScheduleFields accepts a well-formed schedule', () => {
  assert.equal(validateScheduleFields(okSchedule), null);
});

test('validateScheduleFields rejects bad preset_key', () => {
  assert.ok(validateScheduleFields({ ...okSchedule, preset_key: 'nope' }));
});

test('validateScheduleFields bounds cycle_len to 1..28 integer', () => {
  assert.ok(validateScheduleFields({ ...okSchedule, cycle_len: 0, assignment: [] }));
  assert.ok(validateScheduleFields({ ...okSchedule, cycle_len: 29 }));
  assert.ok(validateScheduleFields({ ...okSchedule, cycle_len: 2.5 }));
});

test('validateScheduleFields requires assignment array matching cycle_len of non-empty ids', () => {
  assert.ok(validateScheduleFields({ ...okSchedule, assignment: 'x' }));
  assert.ok(validateScheduleFields({ ...okSchedule, assignment: ['g1', 'g2'] })); // wrong length
  assert.ok(validateScheduleFields({ ...okSchedule, assignment: ['g1', 'g1', 'g2', ''] }));
});

test('validateScheduleFields validates dates and ordering', () => {
  assert.ok(validateScheduleFields({ ...okSchedule, anchor_date: '2026-13-01' }));
  assert.ok(
    validateScheduleFields({ ...okSchedule, starts_on: '2026-08-01', ends_on: '2026-06-01' })
  );
  assert.equal(
    validateScheduleFields({ ...okSchedule, starts_on: '2026-06-01', ends_on: '2026-08-31' }),
    null
  );
});

test('validateScheduleFields caps the label', () => {
  assert.ok(validateScheduleFields({ ...okSchedule, label: 'x'.repeat(61) }));
});

test('validateSchedule checks assignment ids exist as caregivers', () => {
  const d = db();
  assert.equal(validateSchedule(okSchedule, d), null);
  assert.ok(validateSchedule({ ...okSchedule, assignment: ['g1', 'g1', 'g2', 'gX'] }, d));
  d.close();
});

const okOverride = {
  caregiver_id: 'g1',
  date_from: '2026-11-26',
  date_to: '2026-11-29',
  label: 'Thanksgiving',
};

test('validateOverrideFields accepts a well-formed override', () => {
  assert.equal(validateOverrideFields(okOverride), null);
});

test('validateOverrideFields requires caregiver_id, valid dates, ordering, label cap', () => {
  assert.ok(validateOverrideFields({ ...okOverride, caregiver_id: '' }));
  assert.ok(validateOverrideFields({ ...okOverride, date_from: 'nope' }));
  assert.ok(validateOverrideFields({ ...okOverride, date_from: '2026-11-30' })); // from > to
  assert.ok(validateOverrideFields({ ...okOverride, label: 'x'.repeat(61) }));
});

test('validateOverride checks the caregiver exists', () => {
  const d = db();
  assert.equal(validateOverride(okOverride, d), null);
  assert.ok(validateOverride({ ...okOverride, caregiver_id: 'gX' }, d));
  d.close();
});

test('validateCaregiverFields requires a name within cap and a valid hex color', () => {
  assert.equal(validateCaregiverFields({ name: 'Mum', color: '#112233' }), null);
  assert.ok(validateCaregiverFields({ name: '', color: '#112233' }));
  assert.ok(validateCaregiverFields({ name: 'x'.repeat(41), color: '#112233' }));
  assert.ok(validateCaregiverFields({ name: 'Mum', color: 'red' }));
});

test('isHexColor only accepts #rrggbb', () => {
  assert.ok(isHexColor('#aabbcc'));
  assert.ok(!isHexColor('#abc'));
  assert.ok(!isHexColor('aabbcc'));
  assert.ok(!isHexColor('#gggggg'));
});

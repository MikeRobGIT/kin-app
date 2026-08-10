import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeInvolvement, UNASSIGNED } from '../lib/report.js';

const ev = (o) => ({ type: 'school', caregiver_id: 'g1', ...o });
const CGS = [{ id: 'g1', name: 'Dad' }, { id: 'g2', name: 'Mom' }];

test('buckets per caregiver and type, with caregiver order and grand total', () => {
  const r = summarizeInvolvement(
    [ev({ caregiver_id: 'g1', type: 'school' }), ev({ caregiver_id: 'g1', type: 'meal' }), ev({ caregiver_id: 'g2', type: 'school' })],
    CGS
  );
  assert.equal(r.grand, 3);
  assert.equal(r.buckets.g1.total, 2);
  assert.equal(r.buckets.g1.byType.school, 1);
  assert.equal(r.buckets.g2.total, 1);
  assert.deepEqual(r.order, ['g1', 'g2']);
});

test('unassigned events bucket under UNASSIGNED, ordered last', () => {
  const r = summarizeInvolvement([ev({ caregiver_id: null }), ev({ caregiver_id: 'g1' })], CGS);
  assert.equal(r.buckets[UNASSIGNED].total, 1);
  assert.deepEqual(r.order, ['g1', UNASSIGNED]);
});

test('typeKeys follow the TYPES declaration order, present types only', () => {
  // school is declared before meal in lib/constants TYPES
  const r = summarizeInvolvement([ev({ type: 'meal' }), ev({ type: 'school' })], [{ id: 'g1' }]);
  assert.deepEqual(r.typeKeys, ['school', 'meal']);
});

test('empty input yields an empty summary', () => {
  const r = summarizeInvolvement([], CGS);
  assert.equal(r.grand, 0);
  assert.deepEqual(r.order, []);
  assert.deepEqual(r.typeKeys, []);
});

test('a split both-trip credits each parent one leg', () => {
  const r = summarizeInvolvement(
    [ev({ type: 'school', pd: 'both', caregiver_id: 'g1', pickup_caregiver_id: 'g2' })],
    CGS
  );
  assert.equal(r.grand, 2); // one event, two trips
  assert.equal(r.buckets.g1.byType.school, 1); // drop-off leg
  assert.equal(r.buckets.g2.byType.school, 1); // pickup leg
  assert.deepEqual(r.order, ['g1', 'g2']);
});

test('a legacy or same-parent both counts once (no retroactive shift)', () => {
  const legacy = summarizeInvolvement(
    [ev({ pd: 'both', caregiver_id: 'g1', pickup_caregiver_id: null })],
    CGS
  );
  assert.equal(legacy.grand, 1);
  assert.equal(legacy.buckets.g1.total, 1);
  // same parent for both legs is not double-counted (distinctness guard)
  const same = summarizeInvolvement(
    [ev({ pd: 'both', caregiver_id: 'g1', pickup_caregiver_id: 'g1' })],
    CGS
  );
  assert.equal(same.grand, 1);
});

test('a pickup parent is ignored unless the trip is both-legs', () => {
  const drop = summarizeInvolvement(
    [ev({ pd: 'dropoff', caregiver_id: 'g1', pickup_caregiver_id: 'g2' })],
    CGS
  );
  assert.equal(drop.grand, 1);
  assert.equal(drop.buckets.g1.total, 1);
  assert.equal(drop.buckets.g2, undefined);
});

test('a split trip with an unassigned drop-off credits Unassigned + the pickup parent', () => {
  const r = summarizeInvolvement(
    [ev({ pd: 'both', caregiver_id: null, pickup_caregiver_id: 'g2' })],
    CGS
  );
  assert.equal(r.grand, 2);
  assert.equal(r.buckets.g2.total, 1);
  assert.equal(r.buckets[UNASSIGNED].total, 1);
  assert.deepEqual(r.order, ['g2', UNASSIGNED]);
});

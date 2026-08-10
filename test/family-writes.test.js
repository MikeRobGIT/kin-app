import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let db, F;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fam-'));
  ({ default: db } = await import('../lib/db.js')); // seeds c1/c2, g1/g2
  F = await import('../lib/family-writes.js');
});

test('createChild mints the next id + sort and starts active', () => {
  const row = F.createChild({ name: 'Nadia', color: '#123456' });
  assert.equal(row.id, 'c3'); // after seeded c1/c2
  assert.equal(row.name, 'Nadia');
  assert.equal(row.color, '#123456');
  assert.equal(row.archived, 0);
  assert.equal(row.sort, 2); // seeds are 0,1
});

test('createCaregiver mints the g-series id independently', () => {
  const row = F.createCaregiver({ name: 'Gran', color: '#654321' });
  assert.equal(row.id, 'g3');
  assert.equal(row.archived, 0);
});

test('archived members keep their id reserved — mint never reuses it', () => {
  const a = F.createChild({ name: 'Temp', color: '#aaaaaa' }); // c4
  F.updateChild(a.id, { archived: 1 });
  const b = F.createChild({ name: 'Later', color: '#bbbbbb' });
  assert.notEqual(b.id, a.id);
  assert.equal(b.id, 'c5');
});

test('updateChild does a partial update (archive-only leaves name/color)', () => {
  const row = F.createCaregiver({ name: 'Keep', color: '#0f0f0f' }); // g4
  const after = F.updateCaregiver(row.id, { archived: 1 });
  assert.equal(after.name, 'Keep');
  assert.equal(after.color, '#0f0f0f');
  assert.equal(after.archived, 1);
  const back = F.updateCaregiver(row.id, { archived: 0 });
  assert.equal(back.archived, 0);
});

test('updateChild renames/recolors without touching archived', () => {
  const row = F.createChild({ name: 'Bo', color: '#111111' });
  const after = F.updateChild(row.id, { name: 'Bogdan', color: '#222222' });
  assert.equal(after.name, 'Bogdan');
  assert.equal(after.color, '#222222');
  assert.equal(after.archived, 0);
});

test('activeCount reflects archive/unarchive', () => {
  const before = F.activeCount('caregivers');
  const row = F.createCaregiver({ name: 'Flip', color: '#333333' });
  assert.equal(F.activeCount('caregivers'), before + 1);
  F.updateCaregiver(row.id, { archived: 1 });
  assert.equal(F.activeCount('caregivers'), before);
});

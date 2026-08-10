import db from './db.js';

// Children and parents are configuration rows with STABLE ids (events/schedules/seals reference
// them forever). Adding mints the next id; renaming/recoloring/archiving is a partial UPDATE.
// A member is never deleted — "remove" = archive (hidden from pickers/new records, history
// intact). No audit table, matching the existing parent-rename precedent. `table` is always a
// fixed literal from the route ('children' | 'caregivers'), never user input.

// Next id for a table: the seed uses c1/c2 and g1/g2, so mint `<prefix><max numeric suffix + 1>`
// over ALL rows (archived included, so a retired member's id is never reused).
function mintId(table, prefix) {
  let max = 0;
  for (const { id } of db.prepare(`SELECT id FROM ${table}`).all()) {
    const m = /^(\D*)(\d+)$/.exec(id);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}${max + 1}`;
}

// Next sort value = max(sort)+1 so a new member appends after the current ones.
function nextSort(table) {
  const row = db.prepare(`SELECT MAX(sort) AS m FROM ${table}`).get();
  return (row && row.m != null ? row.m : -1) + 1;
}

function insertRow(table, prefix, b) {
  const id = mintId(table, prefix);
  db.prepare(`INSERT INTO ${table} (id, name, color, sort, archived) VALUES (?, ?, ?, ?, 0)`).run(
    id,
    String(b.name).trim(),
    b.color,
    nextSort(table)
  );
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

// Partial update — only the provided fields are written (archive-only PUT touches just archived).
function updateRow(table, id, b) {
  const sets = [];
  const p = { id };
  if (b.name !== undefined) {
    sets.push('name = @name');
    p.name = String(b.name).trim();
  }
  if (b.color !== undefined) {
    sets.push('color = @color');
    p.color = b.color;
  }
  if (b.archived !== undefined) {
    sets.push('archived = @archived');
    p.archived = b.archived ? 1 : 0;
  }
  if (sets.length) db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = @id`).run(p);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

// How many ACTIVE members a table has — the route uses this to refuse archiving the last one.
export function activeCount(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE archived = 0`).get().n;
}

export const createChild = (b) => insertRow('children', 'c', b);
export const updateChild = (id, b) => updateRow('children', id, b);
export const createCaregiver = (b) => insertRow('caregivers', 'g', b);
export const updateCaregiver = (id, b) => updateRow('caregivers', id, b);

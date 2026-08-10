import db from './db.js';

// month_seals is append-only (re-seal keeps history) — a plain insert, no audit-of-audit.
const insert = db.prepare(
  `INSERT INTO month_seals (month, sha256, hmac, event_count)
   VALUES (@month, @sha256, @hmac, @event_count)`
);
const getById = db.prepare('SELECT * FROM month_seals WHERE id = ?');

export const insertSeal = db.transaction((s) => {
  const info = insert.run(s);
  return getById.get(info.lastInsertRowid);
});

export function listSeals() {
  return db.prepare('SELECT * FROM month_seals ORDER BY month DESC, id DESC').all();
}

export function getLatestSeal(month) {
  return db.prepare('SELECT * FROM month_seals WHERE month = ? ORDER BY id DESC LIMIT 1').get(month);
}

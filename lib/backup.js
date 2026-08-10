import path from 'node:path';
import fs from 'node:fs';

// Before any pending migration rewrites an existing record, snapshot the DB to the
// data volume so the migrating deploy always leaves a pre-migration rollback point —
// no manual/terminal step needed. The copy is consistent and restorable: SQLite
// recovers/reads through the WAL on open, so VACUUM INTO captures all committed data
// (including WAL-resident frames) into a standalone file with no -wal/-shm sidecars.
// VACUUM INTO runs outside any transaction.
//
// Idempotent per version: the file name is keyed only to the pre-migration
// user_version, so one snapshot exists per migration step. If it already exists (e.g.
// a prior boot attempt that then crash-looped — the app cannot serve or mutate data
// while a migration is pending, so the existing copy is still accurate), reuse it
// rather than letting VACUUM INTO hard-fail on an existing target and brick boot.
//
// Returns the snapshot path, or null when skipped (fresh DB with no events table, or
// already at the latest version). Throws if a new snapshot cannot be written — callers
// MUST NOT migrate the only copy of an existing record without a rollback point.
// dataDir is operator-controlled config (not user input); quotes are escaped anyway.
export function snapshotBeforeMigrations(db, dataDir, latestVersion) {
  const version = db.pragma('user_version', { simple: true }) || 0;
  const hasEvents = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'")
    .get();
  if (version >= latestVersion || !hasEvents) return null;
  const snap = path.join(dataDir, `pre-migration-v${version}.db`);
  if (fs.existsSync(snap)) return snap; // already snapshotted this version — reuse
  try {
    db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  } catch (e) {
    // VACUUM INTO can leave a partial/empty target if it fails partway (e.g. SQLITE_BUSY under
    // a container-swap lock). Remove it so the reuse-check above can't trust a corrupt snapshot
    // on the next retry — the retry must recreate a complete one. (gemini HIGH, PR #12.)
    try {
      fs.rmSync(snap, { force: true });
    } catch {
      /* best effort — nothing to reuse anyway */
    }
    throw e;
  }
  return snap;
}

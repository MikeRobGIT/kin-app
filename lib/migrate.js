// Ordered schema migrations. The array index + 1 is each migration's target
// PRAGMA user_version. runMigrations applies every migration whose version is
// greater than the DB's current user_version, each in its own transaction.

export const migrations = [
  // 1 — baseline: bring a fresh OR a pre-versioning DB to a known v1 state.
  function baseline(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS children (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        color TEXT NOT NULL,
        sort  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS caregivers (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        color TEXT NOT NULL,
        sort  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        id        TEXT PRIMARY KEY,
        title     TEXT NOT NULL,
        type      TEXT NOT NULL,
        child_id  TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        pd        TEXT NOT NULL DEFAULT 'dropoff',
        date      TEXT NOT NULL,
        time      TEXT NOT NULL DEFAULT '08:00',
        who       TEXT DEFAULT '',
        notes     TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    `);
    // Pre-versioning DBs may already have caregiver_id from the old ALTER path.
    const hasCaregiver = db
      .prepare('PRAGMA table_info(events)')
      .all()
      .some((c) => c.name === 'caregiver_id');
    if (!hasCaregiver) {
      db.exec('ALTER TABLE events ADD COLUMN caregiver_id TEXT REFERENCES caregivers(id)');
    }
    // A legacy DB hand-edited via sqlite3 could hold an event pointing at a
    // since-removed caregiver. caregiver_id is nullable with no enforced FK on the
    // old schema, so normalize any such orphan to NULL (Unassigned) — otherwise the
    // post-migration foreign_key_check gate would fail and brick startup on a loop.
    db.exec(
      'UPDATE events SET caregiver_id = NULL ' +
        'WHERE caregiver_id IS NOT NULL ' +
        'AND caregiver_id NOT IN (SELECT id FROM caregivers)'
    );
    // child_id is NOT NULL and is the record's anchor — we cannot safely repair an
    // orphan automatically. If a hand-edited DB holds events pointing at a missing
    // child, fail here with an actionable message rather than letting migration 4's
    // foreign_key_check throw an opaque error and crash-loop the container on boot.
    const orphanChildren = db
      .prepare('SELECT id, child_id FROM events WHERE child_id NOT IN (SELECT id FROM children)')
      .all();
    if (orphanChildren.length) {
      throw new Error(
        `Cannot migrate: ${orphanChildren.length} event(s) reference a missing child_id ` +
          `(e.g. event ${orphanChildren[0].id} -> child ${orphanChildren[0].child_id}). ` +
          `Restore the child row(s) or remove these events, then redeploy.`
      );
    }
  },
  // 2 — add updated_at (set on every edit; created_at stays immutable).
  function addUpdatedAt(db) {
    const has = db
      .prepare('PRAGMA table_info(events)')
      .all()
      .some((c) => c.name === 'updated_at');
    if (!has) db.exec('ALTER TABLE events ADD COLUMN updated_at TEXT');
  },
  // 3 — append-only audit log. event_id is intentionally NOT a foreign key:
  // the snapshot must outlive the deleted event it records.
  function addAudit(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_audit (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        action   TEXT NOT NULL CHECK(action IN ('create','update','delete')),
        at       TEXT NOT NULL DEFAULT (datetime('now')),
        snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_event ON event_audit(event_id);
    `);
  },
  // 4 — rebuild events: child_id ON DELETE RESTRICT (a mis-deleted child can no
  // longer wipe its history) + CHECK constraints for pd and date/time shape.
  // Length caps are enforced in the app layer (route handlers today; moving to
  // lib/validate.js in a later task), NOT here, so the rebuild never rejects a
  // legacy over-length row. SQLite can't ALTER constraints in place.
  function hardenEvents(db) {
    db.exec(`
      CREATE TABLE events_new (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        type       TEXT NOT NULL,
        child_id   TEXT NOT NULL REFERENCES children(id) ON DELETE RESTRICT,
        caregiver_id TEXT REFERENCES caregivers(id),
        pd         TEXT NOT NULL DEFAULT 'dropoff' CHECK(pd IN ('dropoff','pickup','both')),
        date       TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        time       TEXT NOT NULL DEFAULT '08:00' CHECK(time GLOB '[0-9][0-9]:[0-9][0-9]'),
        who        TEXT DEFAULT '',
        notes      TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT
      );
      INSERT INTO events_new
        (id,title,type,child_id,caregiver_id,pd,date,time,who,notes,created_at,updated_at)
        SELECT id,title,type,child_id,caregiver_id,pd,date,time,
               COALESCE(who,''),COALESCE(notes,''),created_at,updated_at
        FROM events;
    `);
    const oldN = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const newN = db.prepare('SELECT COUNT(*) AS n FROM events_new').get().n;
    if (oldN !== newN) throw new Error(`events rebuild row mismatch: ${oldN} -> ${newN}`);
    db.exec(`
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    `);
  },
  // 5 — parent-time scheduling. New tables only (no rebuild), so the post-migration
  // foreign_key_check gate passes trivially. `assignment` is a JSON array of
  // caregiver_id; membership is enforced in lib/validate.js (SQLite can't FK into
  // JSON). Renaming a parent is just an UPDATE on caregivers (no schema change), so
  // schedules/overrides that reference the stable ids never break. Overrides layer on
  // top of the base rotation and win for the dates they cover (resolved in lib/schedule.js).
  function addSchedules(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL DEFAULT '',
        preset_key  TEXT NOT NULL DEFAULT 'custom',
        cycle_len   INTEGER NOT NULL CHECK(cycle_len >= 1 AND cycle_len <= 28),
        assignment  TEXT NOT NULL,
        anchor_date TEXT NOT NULL CHECK(anchor_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        starts_on   TEXT CHECK(starts_on IS NULL OR starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        ends_on     TEXT CHECK(ends_on   IS NULL OR ends_on   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT
      );
      CREATE TABLE IF NOT EXISTS schedule_overrides (
        id           TEXT PRIMARY KEY,
        caregiver_id TEXT NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
        date_from    TEXT NOT NULL CHECK(date_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        date_to      TEXT NOT NULL CHECK(date_to   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        label        TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT
      );
      CREATE TABLE IF NOT EXISTS schedule_audit (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        kind     TEXT NOT NULL CHECK(kind IN ('schedule','override')),
        ref_id   TEXT NOT NULL,
        action   TEXT NOT NULL CHECK(action IN ('create','update','delete')),
        at       TEXT NOT NULL DEFAULT (datetime('now')),
        snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_audit_ref ON schedule_audit(ref_id);
    `);
  },
  // 6 — monthly cryptographic seals (record-integrity capstone). New table only, so the
  // post-migration foreign_key_check gate passes trivially. Append-only by design: no
  // UNIQUE on month, so re-sealing a month inserts a new row and keeps prior seals as
  // history. sha256 is over the month's canonical record (events + per-night parent
  // attribution); hmac is HMAC-SHA256 of that record keyed by AUTH_SECRET (computed in the
  // app layer — the key never touches the DB). See lib/seal.js.
  function addMonthSeals(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS month_seals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        month       TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
        algo        TEXT NOT NULL DEFAULT 'sha256+hmac-sha256',
        sha256      TEXT NOT NULL,
        hmac        TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        sealed_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_month_seals_month ON month_seals(month);
    `);
  },
  // 7 — lawyer share links (capability tokens). New table only → FK gate trivial. A token is a
  // high-entropy random secret shown ONCE in the URL; only its HMAC-SHA256(AUTH_SECRET, token) is
  // stored (token_hash), so a DB leak never yields a usable link. Stored (not stateless) so a link
  // is revocable; expiry is enforced server-side in the lookup query. The token grants read-only
  // access to the involvement report for [date_from, date_to] only — no mutations, no other routes.
  function addShareTokens(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS share_tokens (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash  TEXT NOT NULL UNIQUE,
        label       TEXT NOT NULL DEFAULT '',
        date_from   TEXT NOT NULL CHECK(date_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        date_to     TEXT NOT NULL CHECK(date_to   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        expires_at  TEXT NOT NULL,
        revoked     INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_share_tokens_hash ON share_tokens(token_hash);
    `);
  },
  // 8 — recurring-event series linkage. A nullable column added in place (ALTER, like
  // migrations 1-2), so existing and one-off events stay series_id=NULL and the post-migration
  // foreign_key_check gate passes trivially (no FK change). Occurrences of one recurring rule
  // share a server-generated series_id, enabling edit/delete of the whole run (lib/event-writes.js).
  function addSeriesId(db) {
    const has = db
      .prepare('PRAGMA table_info(events)')
      .all()
      .some((c) => c.name === 'series_id');
    if (!has) db.exec('ALTER TABLE events ADD COLUMN series_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_series ON events(series_id)');
  },
  // 9 — in-app MCP agent tokens. New table only → FK gate trivial. Same capability-token
  // discipline as share_tokens (v7): the raw token is shown ONCE at mint; only its
  // HMAC-SHA256(AUTH_SECRET, token) is stored, so a DB leak never yields a usable credential.
  // Unlike share links these are long-lived personal agent credentials: no expiry — revocation
  // (soft flag, enforced in the lookup SQL) is the kill switch. last_used_at gives the owner
  // visibility into whether an agent still uses its token. The KIN_MCP_TOKEN env var remains a
  // valid fallback credential (checked in lib/mcp-auth.js), so existing deploys keep working.
  function addMcpTokens(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash   TEXT NOT NULL UNIQUE,
        label        TEXT NOT NULL DEFAULT '',
        revoked      INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash);
    `);
  },
  // 10 — split pickup/drop-off parent. A nullable column added in place (ALTER, like migrations
  // 1-2 and 8), so existing and one-off events stay pickup_caregiver_id=NULL and the post-migration
  // foreign_key_check gate passes trivially (an all-NULL FK column has no rows to violate).
  // Used only for a two-leg trip (pd='both') to name a distinct pickup parent; caregiver_id stays
  // the drop-off / sole-leg parent and the write layer forces this NULL otherwise. See
  // lib/event-writes.js normalize().
  function addPickupCaregiver(db) {
    const has = db
      .prepare('PRAGMA table_info(events)')
      .all()
      .some((c) => c.name === 'pickup_caregiver_id');
    if (!has)
      db.exec('ALTER TABLE events ADD COLUMN pickup_caregiver_id TEXT REFERENCES caregivers(id)');
  },
  // 11 — family roster management: an `archived` flag on children and caregivers so a member can
  // be retired from the pickers / AI-parse / MCP / new rotations WITHOUT deleting history. A hard
  // delete is unsafe anyway (events FK-restrict child_id; a caregiver delete cascades their
  // schedule_overrides → retroactively changes computed parent-on-duty → already-sealed months
  // read as tampered). Additive NOT NULL DEFAULT 0 columns like migrations 8/10, so existing rows
  // become active (0) and the post-migration foreign_key_check passes trivially.
  function addArchivedFlags(db) {
    for (const t of ['children', 'caregivers']) {
      const has = db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'archived');
      if (!has) db.exec(`ALTER TABLE ${t} ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
    }
  },
  // 12 — external iCal subscriptions + their imported-event linkage. A new table
  // (calendar_subscriptions) plus two nullable, plain-TEXT columns on events
  // (subscription_id, ical_uid). The event columns carry NO foreign key — they are dedup
  // tags, not integrity anchors — so the ALTERs stay FK-safe like migrations 8/10 and the
  // post-migration foreign_key_check passes trivially. A "Sync now" pull dedups on
  // (subscription_id, ical_uid, date) and only ADDS occurrences not already imported. The
  // subscription's child_id/caregiver_id DO FK into the roster (safe: family rows are archived,
  // never hard-deleted). Deleting a subscription clears the tag on its events (they stay as plain
  // events), so no ON DELETE cascade is needed. See lib/ical.js + lib/subscription-writes.js.
  function addCalendarSubscriptions(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_subscriptions (
        id             TEXT PRIMARY KEY,
        label          TEXT NOT NULL DEFAULT '',
        url            TEXT NOT NULL,
        child_id       TEXT NOT NULL REFERENCES children(id),
        type           TEXT NOT NULL DEFAULT 'sport',
        caregiver_id   TEXT REFERENCES caregivers(id),
        pd             TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        last_synced_at TEXT,
        last_status    TEXT
      );
    `);
    for (const col of ['subscription_id', 'ical_uid']) {
      const has = db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === col);
      if (!has) db.exec(`ALTER TABLE events ADD COLUMN ${col} TEXT`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_ical ON events(subscription_id, ical_uid, date)');
  },
  // 13 — per-event child routing, for a class-portal feed that carries BOTH kids and names them
  // only in the SUMMARY ("Ivy Carter - Minnows"). Two parts.
  //
  // (a) calendar_subscriptions is REBUILT (SQLite cannot drop a NOT NULL in place) so child_id
  // becomes NULLABLE: NULL means "route each event to a child by the name in its title" instead of
  // pinning the whole feed to one kid. Existing rows keep their child_id, so every current
  // subscription behaves exactly as before. The same rebuild adds child_map — a JSON object
  // { normalized-title-key: child_id } holding the user's one-time manual assignments plus the keys
  // still awaiting one (value ''), so a re-sync reuses the decision instead of asking again.
  // JSON-in-a-column follows schedules.assignment (v5): SQLite can't FK into JSON, so membership is
  // validated in lib/validate.js. It also keeps the rules inside lib/export.js's existing SELECT *
  // (a separate table would have to be hand-added there — the v5 defect that rule exists for) and
  // makes them die with their subscription: a rules table FK'd here with no ON DELETE would make
  // any feed that ever produced a pending rule UNDELETABLE, since foreign_keys is ON at runtime.
  // Rebuild direction matters — _new is renamed ONTO the real name, never the old table aside:
  // since SQLite 3.25 RENAME TO rewrites references in other tables' FK clauses. v12 created no
  // index on this table, so none needs recreating. Row-count guard as in migration 4; the runner's
  // FK-off + foreign_key_check gates the result.
  //
  // (b) events gains ical_key — the routing key an imported row came from — so dedup can key on
  // (subscription_id, ical_uid, date, ical_key). Without it, a feed whose UID identifies the CLASS
  // rather than the registration collapses both kids' same-day occurrence onto one dedup key and
  // silently drops the second. The key is the SOURCE identity, unchanged when the user reassigns a
  // rule, so reassignment stays a no-op on already-imported events (sync is add-only). Nullable
  // plain TEXT with no FK, exactly like subscription_id/ical_uid in v12 — a dedup tag, not an
  // integrity anchor — so the post-migration foreign_key_check passes trivially.
  // See lib/ical-map.js + docs/ical-subscriptions.md.
  function addPerEventChildRouting(db) {
    db.exec(`
      CREATE TABLE calendar_subscriptions_new (
        id             TEXT PRIMARY KEY,
        label          TEXT NOT NULL DEFAULT '',
        url            TEXT NOT NULL,
        child_id       TEXT REFERENCES children(id),
        type           TEXT NOT NULL DEFAULT 'sport',
        caregiver_id   TEXT REFERENCES caregivers(id),
        pd             TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        last_synced_at TEXT,
        last_status    TEXT,
        child_map      TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO calendar_subscriptions_new
        (id,label,url,child_id,type,caregiver_id,pd,created_at,last_synced_at,last_status)
        SELECT id,label,url,child_id,type,caregiver_id,pd,created_at,last_synced_at,last_status
        FROM calendar_subscriptions;
    `);
    const oldN = db.prepare('SELECT COUNT(*) AS n FROM calendar_subscriptions').get().n;
    const newN = db.prepare('SELECT COUNT(*) AS n FROM calendar_subscriptions_new').get().n;
    if (oldN !== newN)
      throw new Error(`calendar_subscriptions rebuild row mismatch: ${oldN} -> ${newN}`);
    db.exec(`
      DROP TABLE calendar_subscriptions;
      ALTER TABLE calendar_subscriptions_new RENAME TO calendar_subscriptions;
    `);
    const has = db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'ical_key');
    if (!has) db.exec('ALTER TABLE events ADD COLUMN ical_key TEXT');
    db.exec(`
      DROP INDEX IF EXISTS idx_events_ical;
      CREATE INDEX IF NOT EXISTS idx_events_ical
        ON events(subscription_id, ical_uid, date, ical_key);
    `);
  },
  // 14 — a fourth trip kind, 'none': a TRIP-typed activity that carried zero legs on this occasion
  // (a school day the child never left home, a camp week the bus collected her, teletherapy). Before
  // this, such a day could only be saved as a fabricated 'dropoff' — a positive assertion of a
  // drive that never happened, inside a record whose whole value is its month seal.
  //
  // Widening `CHECK(pd IN (...))` (migration 4, :102) forces a full rebuild: SQLite cannot ALTER a
  // CHECK in place. The rebuild copies data ONLY — every column by explicit name, no expression on
  // any of them, ZERO rows updated. That discipline is not stylistic:
  //   * lib/seal.js seals `pd`, `created_at` and `updated_at` RAW, so a fired
  //     `DEFAULT (datetime('now'))` or a stray COALESCE silently invalidates every prior month seal
  //     — with no error anywhere. Migration 4's own rebuild COALESCEd who/notes; don't copy that.
  //   * The row-count guard alone CANNOT see it (a rebuild that drops created_at from the INSERT
  //     list still counts 1 -> 1), and the runner's foreign_key_check is blind to a missing column,
  //     a lost NOT NULL or a lost PRIMARY KEY. Hence the per-column drift join below.
  //
  // !! NEVER ADD `UPDATE events SET pd='none' WHERE <a non-trip type>` — not here, not in a later
  // migration. Caregiving rows store an inert filler pd='dropoff' and must keep it forever:
  // lib/seal.js:31 serializes `pd: e.pd` UNCONDITIONALLY (unlike :30's conditional
  // pickup_caregiver_id spread), and month_seals stores only sha256/hmac (:171-188), never the
  // canonical string — so such an UPDATE would report every month containing a single meal or
  // bedtime row as tampered, unrecoverably. The drift guard below would abort it.
  function addPdNone(db) {
    // The live column set: migration 4's twelve, then series_id (v8), pickup_caregiver_id (v10),
    // subscription_id + ical_uid (v12), ical_key (v13). Migration 4's DDL text is five columns short
    // — never copy an older rebuild verbatim.
    const COLS = [
      'id', 'title', 'type', 'child_id', 'caregiver_id', 'pd', 'date', 'time', 'who', 'notes',
      'created_at', 'updated_at', 'series_id', 'pickup_caregiver_id', 'subscription_id',
      'ical_uid', 'ical_key',
    ];
    // Fail loudly rather than silently dropping a column a later migration added without updating
    // this list. Aborts inside the runner's transaction, so nothing is lost.
    const extra = db
      .prepare('PRAGMA table_info(events)')
      .all()
      .map((c) => c.name)
      .filter((c) => !COLS.includes(c));
    if (extra.length)
      throw new Error(`events rebuild would drop column(s): ${extra.join(', ')} — add them to migration 14`);

    const list = COLS.join(',');
    db.exec(`
      CREATE TABLE events_new (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        type       TEXT NOT NULL,
        child_id   TEXT NOT NULL REFERENCES children(id) ON DELETE RESTRICT,
        caregiver_id TEXT REFERENCES caregivers(id),
        pd         TEXT NOT NULL DEFAULT 'dropoff' CHECK(pd IN ('dropoff','pickup','both','none')),
        date       TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        time       TEXT NOT NULL DEFAULT '08:00' CHECK(time GLOB '[0-9][0-9]:[0-9][0-9]'),
        who        TEXT DEFAULT '',
        notes      TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT,
        series_id  TEXT,
        pickup_caregiver_id TEXT REFERENCES caregivers(id),
        subscription_id TEXT,
        ical_uid   TEXT,
        ical_key   TEXT
      );
      INSERT INTO events_new (${list}) SELECT ${list} FROM events;
    `);
    const oldN = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const newN = db.prepare('SELECT COUNT(*) AS n FROM events_new').get().n;
    if (oldN !== newN) throw new Error(`events rebuild row mismatch: ${oldN} -> ${newN}`);
    // Per-column, NULL-safe (`IS NOT`) comparison of every copied value. This is the guard the
    // row count can't be: it catches a fired DEFAULT, a COALESCE, a mistyped column pairing.
    const drift = db
      .prepare(
        `SELECT COUNT(*) AS n FROM events o JOIN events_new n ON n.id = o.id
         WHERE ${COLS.filter((c) => c !== 'id').map((c) => `o.${c} IS NOT n.${c}`).join(' OR ')}`
      )
      .get().n;
    if (drift) throw new Error(`events rebuild altered ${drift} row(s) — aborting (seal safety)`);

    // Rename _new ONTO the real name, never the old table aside (see migration 13's note). DROP
    // TABLE takes the indexes with it, so all three are recreated — idx_events_ical is the FOUR
    // column v13 form; restoring v12's three-column version silently degrades every iCal dedup.
    db.exec(`
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX IF NOT EXISTS idx_events_date   ON events(date);
      CREATE INDEX IF NOT EXISTS idx_events_series ON events(series_id);
      CREATE INDEX IF NOT EXISTS idx_events_ical   ON events(subscription_id, ical_uid, date, ical_key);
    `);
  },
];

// Block the (single, boot-time) thread for `ms`. We WANT to block until the DB is migratable —
// the app must not serve while a migration is pending — so a synchronous wait is correct here.
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Run `fn` (a migration pass), retrying on SQLITE_BUSY. Migration-on-boot takes a write lock, and
// during a container swap the old and new containers both hold /app/data/tracker.db (Litestream is
// replicating it) — so the new container's migration can briefly lose the lock and throw
// SQLITE_BUSY, crash-looping the boot. `busy_timeout` waits out most of the overlap; this retries
// so a transient lock can't take the app down. Non-BUSY errors (a real migration bug) rethrow at
// once. (Real: the v8 deploy 500'd until a manual restart — 2026-07-01.)
export function runWithBusyRetry(fn, { attempts = 3, delayMs = 3000, onRetry } = {}) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (e && e.code === 'SQLITE_BUSY' && i < attempts) {
        if (onRetry) onRetry(i, e);
        sleepSync(delayMs);
        continue;
      }
      throw e;
    }
  }
}

export function runMigrations(db, migs = migrations) {
  const current = db.pragma('user_version', { simple: true }) || 0;
  if (current >= migs.length) return;
  // foreign_keys MUST be toggled outside a transaction; later migrations rebuild
  // tables and need it off. Restore it on the way out.
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < migs.length; v++) {
      const apply = db.transaction(() => {
        migs[v](db);
        // FK enforcement is off during the migration; verify integrity explicitly
        // so a migration that orphans rows rolls back instead of silently committing.
        const violations = db.pragma('foreign_key_check');
        if (violations.length) {
          throw new Error(
            `Migration ${v + 1} produced foreign-key violations: ${JSON.stringify(violations)}`
          );
        }
        db.pragma(`user_version = ${v + 1}`);
      });
      apply();
    }
  } finally {
    // The runner assumes FK enforcement is ON for callers and leaves it ON.
    db.pragma('foreign_keys = ON');
  }
}

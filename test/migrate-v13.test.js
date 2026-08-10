import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, migrations } from '../lib/migrate.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

test('migrations include v13 and a fresh DB reaches it', () => {
  assert.ok(migrations.length >= 13);
  const db = freshDb();
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  db.close();
});

test('v13 makes child_id nullable and adds child_map defaulting to {}', () => {
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(calendar_subscriptions)').all();
  assert.equal(cols.find((c) => c.name === 'child_id').notnull, 0);
  assert.equal(cols.find((c) => c.name === 'child_map').notnull, 1);
  // Assert the default by BEHAVIOR, not by dflt_value: for a TEXT default PRAGMA reports the SQL
  // literal ("'{}'", quotes included), unlike v11's numeric '0'. Omitting child_id also proves the
  // column is genuinely nullable now — that insert would have failed under v12.
  db.prepare("INSERT INTO calendar_subscriptions (id,url,type) VALUES ('s1','https://x/y.ics','sport')").run();
  const row = db.prepare('SELECT child_id, child_map FROM calendar_subscriptions WHERE id=?').get('s1');
  assert.equal(row.child_id, null);
  assert.equal(row.child_map, '{}');
  db.close();
});

test('the rebuilt table still enforces its child_id foreign key', () => {
  const db = freshDb();
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO calendar_subscriptions (id,url,type,child_id) VALUES ('s2','https://x/y.ics','sport','nope')"
        )
        .run(),
    /FOREIGN KEY/
  );
  db.close();
});

test('v13 adds events.ical_key and widens the ical dedup index to include it', () => {
  const db = freshDb();
  assert.ok(db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'ical_key'));
  const cols = db.prepare('PRAGMA index_info(idx_events_ical)').all().map((r) => r.name);
  assert.deepEqual(cols, ['subscription_id', 'ical_uid', 'date', 'ical_key']);
  db.close();
});

test('v13 carries rows written under v12 through the table rebuild', () => {
  // Migrate only to v12, write a subscription + an event tagged to it, THEN apply v13 — so the
  // INSERT..SELECT copy is actually exercised. A fresh DB would insert after the rebuild and only
  // test the new shape.
  const db = new Database(':memory:');
  runMigrations(db, migrations.slice(0, 12));
  assert.equal(db.pragma('user_version', { simple: true }), 12);
  db.prepare("INSERT INTO children (id,name,color,sort) VALUES ('c1','Ivy','#000000',0)").run();
  db.prepare(
    `INSERT INTO calendar_subscriptions (id,label,url,child_id,type,created_at,last_status)
     VALUES ('sub1','Swim','https://x/y.ics','c1','sport','2026-01-02 03:04:05','ok')`
  ).run();
  db.prepare(
    `INSERT INTO events (id,title,type,child_id,pd,date,time,subscription_id,ical_uid)
     VALUES ('e1','Minnows','sport','c1','dropoff','2026-08-15','10:30','sub1','u1')`
  ).run();

  runMigrations(db); // apply v13

  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_subscriptions').get().n, 1);
  const sub = db.prepare('SELECT * FROM calendar_subscriptions WHERE id=?').get('sub1');
  assert.equal(sub.child_id, 'c1'); // an existing pinned feed keeps behaving exactly as before
  assert.equal(sub.label, 'Swim');
  assert.equal(sub.created_at, '2026-01-02 03:04:05');
  assert.equal(sub.last_status, 'ok');
  assert.equal(sub.child_map, '{}');
  const ev = db.prepare('SELECT subscription_id, ical_uid, ical_key FROM events WHERE id=?').get('e1');
  assert.equal(ev.subscription_id, 'sub1'); // the imported event still resolves to its feed
  assert.equal(ev.ical_uid, 'u1');
  assert.equal(ev.ical_key, null);
  db.close();
});

test('v13 leaves no foreign-key violations on a fresh DB', () => {
  const db = freshDb();
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
});

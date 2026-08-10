// A faithful, complete dump of the record — every column, every row, plus the
// audit trail. This is the defensible handoff artifact (the report CSV is a
// human summary). Timestamps are stored UTC; see lib/format.js for display.
export function buildExport(db) {
  return {
    schema_version: db.pragma('user_version', { simple: true }),
    exported_at: new Date().toISOString(),
    note: 'Timestamps (created_at, updated_at, event_audit.at) are UTC.',
    children: db.prepare('SELECT * FROM children ORDER BY sort').all(),
    caregivers: db.prepare('SELECT * FROM caregivers ORDER BY sort').all(),
    events: db.prepare('SELECT * FROM events ORDER BY date, time').all(),
    event_audit: db.prepare('SELECT * FROM event_audit ORDER BY id').all(),
    // Parent-time schedule + the monthly seals so a restored DB stays complete and its
    // sealed months remain re-verifiable (the seal attribution is derived from these).
    schedules: db.prepare('SELECT * FROM schedules ORDER BY created_at').all(),
    schedule_overrides: db.prepare('SELECT * FROM schedule_overrides ORDER BY created_at').all(),
    schedule_audit: db.prepare('SELECT * FROM schedule_audit ORDER BY id').all(),
    month_seals: db.prepare('SELECT * FROM month_seals ORDER BY id').all(),
    // token_hash only — raw share tokens are never stored, so this leaks no usable links.
    share_tokens: db.prepare('SELECT * FROM share_tokens ORDER BY id').all(),
    // token_hash only, same discipline — raw MCP tokens are never stored.
    mcp_tokens: db.prepare('SELECT * FROM mcp_tokens ORDER BY id').all(),
    // Saved iCal feed subscriptions (v12) — the feed URL + its child/type mapping and sync state.
    // Imported events carry subscription_id/ical_uid in the events dump above via SELECT *.
    calendar_subscriptions: db.prepare('SELECT * FROM calendar_subscriptions ORDER BY created_at').all(),
  };
}

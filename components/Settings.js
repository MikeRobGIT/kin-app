'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fmtRecorded } from '@/lib/format';
import { TYPES, isTrip, takesLeg } from '@/lib/constants';
// Pure helper — no db, no `ical.js` — so importing it here can't drag the RFC 5545 parser into the
// client bundle (see lib/ical-map.js).
import { parseChildMap, ruleEntry, hasName, guessType } from '@/lib/ical-map';
import ScheduleManager from '@/components/ScheduleManager';

// Settings — calendar display prefs, the parent-time manager, agent access (MCP tokens),
// and log out. Token minting mirrors the share-link manager on /report: mint (raw token
// shown ONCE), list, revoke. Tokens have no expiry; revocation is the kill switch.
// Rotating AUTH_SECRET invalidates every minted token (HMAC-keyed).

// Copy a snippet to the clipboard with a brief confirmation. clipboard.writeText needs a
// secure context (HTTPS or localhost) — both our dev and prod qualify; the try/catch just
// keeps the <pre> selectable if it's ever missing.
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the snippet is still selectable by hand */
    }
  }
  return (
    <button type="button" className="btn btn-copy" onClick={copy} aria-live="polite">
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// A copy-paste code snippet: a scrollable <pre> with a Copy button above it (a long URL/JSON
// pans inside the box rather than overflowing the page — 375px house rule).
function Snippet({ code }) {
  return (
    <div className="code-wrap">
      <div className="code-bar">
        <CopyButton text={code} />
      </div>
      <pre className="code-block">{code}</pre>
    </div>
  );
}

// Suggested colors for a new family member (cycled by current count). The user can always
// pick another with the color input.
const PALETTE = ['#c8553d', '#3a6b5e', '#2d6a9f', '#b5396b', '#8a5a2b', '#7b4f9e', '#1f7a4d', '#b08300'];

// One JSON request to a family endpoint. Surfaces the server's error message; routes a 401 to
// login. Returns { ok } so the caller can refresh on success.
async function familyReq(url, method, body, onAuthError) {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      onAuthError();
      return { ok: false };
    }
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(d.error || 'Could not save');
      return { ok: false };
    }
    return { ok: true, data: d };
  } catch {
    alert('Network error');
    return { ok: false };
  }
}

// An active child/parent: recolor + rename (Save enabled only when changed) + Archive.
function FamilyRow({ endpoint, row, canArchive, onChanged, onAuthError }) {
  const [name, setName] = useState(row.name);
  const [color, setColor] = useState(row.color);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== row.name || color !== row.color;

  async function save() {
    setBusy(true);
    const r = await familyReq(`/api/${endpoint}/${row.id}`, 'PUT', { name: name.trim(), color }, onAuthError);
    setBusy(false);
    if (r.ok) await onChanged();
  }
  async function archive() {
    setBusy(true);
    const r = await familyReq(`/api/${endpoint}/${row.id}`, 'PUT', { archived: 1 }, onAuthError);
    setBusy(false);
    if (r.ok) await onChanged();
  }

  return (
    <div className="family-row">
      <input type="color" aria-label="Color" value={color} onChange={(e) => setColor(e.target.value)} />
      <input
        type="text"
        aria-label="Name"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
      />
      <button className="btn" onClick={save} disabled={busy || !dirty || !name.trim()}>
        Save
      </button>
      <button
        className="btn btn-del"
        onClick={archive}
        disabled={busy || !canArchive}
        title={canArchive ? 'Hide from new events (keeps history)' : 'Add another first'}
      >
        Archive
      </button>
    </div>
  );
}

// Add a new active child/parent.
function FamilyAddRow({ endpoint, noun, suggestColor, onChanged, onAuthError }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(suggestColor);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    const r = await familyReq(`/api/${endpoint}`, 'POST', { name: name.trim(), color }, onAuthError);
    setBusy(false);
    if (r.ok) {
      setName('');
      await onChanged();
    }
  }

  return (
    <div className="family-row family-add">
      <input type="color" aria-label="Color" value={color} onChange={(e) => setColor(e.target.value)} />
      <input
        type="text"
        aria-label={`New ${noun} name`}
        placeholder={`Add ${noun}…`}
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
      />
      <button className="btn" onClick={add} disabled={busy || !name.trim()}>
        Add
      </button>
    </div>
  );
}

// A child or parent list: active rows (editable) + an add row + a collapsed Archived group.
function FamilyManager({ noun, endpoint, rows, onChanged, onAuthError }) {
  const active = rows.filter((r) => !r.archived);
  const archived = rows.filter((r) => r.archived);

  async function unarchive(id) {
    const r = await familyReq(`/api/${endpoint}/${id}`, 'PUT', { archived: 0 }, onAuthError);
    if (r.ok) await onChanged();
  }

  return (
    <div className="family-list">
      {active.map((r) => (
        <FamilyRow
          key={r.id}
          endpoint={endpoint}
          row={r}
          canArchive={active.length > 1}
          onChanged={onChanged}
          onAuthError={onAuthError}
        />
      ))}
      <FamilyAddRow
        /* remount after a successful add (rows grows) so the suggested color advances */
        key={rows.length}
        endpoint={endpoint}
        noun={noun}
        suggestColor={PALETTE[rows.length % PALETTE.length]}
        onChanged={onChanged}
        onAuthError={onAuthError}
      />
      {archived.length > 0 && (
        <details className="family-archived">
          <summary>Archived ({archived.length})</summary>
          {archived.map((r) => (
            <div key={r.id} className="family-row family-arch-row">
              <span className="family-dot" style={{ background: r.color }} aria-hidden="true" />
              <span className="family-arch-name">{r.name}</span>
              <button className="btn" onClick={() => unarchive(r.id)}>
                Unarchive
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// One saved routing rule for a multi-child feed: the normalized title key a group of events shares,
// and the child they belong to. ASSIGNED rules are listed alongside pending ones — a mis-assignment
// has to be fixable in place, because delete + re-add mints a new subscription id, which defeats
// dedup and re-imports the whole feed as duplicates.
function NameRule({ ruleKey, entry, options, defaultTitle, defaultType, busy, onSave }) {
  // A stored id can point at a child archived since the assignment; fall back to "choose" rather
  // than rendering an invalid <select> value that would 400 on save (kin.md client-state rule).
  const [v, setV] = useState(options.some((o) => o.id === entry.child_id) ? entry.child_id : '');
  // Starts EMPTY with the computed default as a placeholder — never pre-filled. A pre-filled value
  // would be persisted as a custom title on the first Save even when the user only came to pick a
  // child, which for a segment that names people ("Ivy & Owen") would title every event in the
  // group after a person and collapse two different classes into one name. Empty means "use the
  // default", which routeTitle recomputes per event.
  const [t, setT] = useState(entry.title);
  // Same discipline for the activity: the guess is the '' option's LABEL, never a pre-selected
  // value. A pre-selected value submits, so the first Save would pin that guess forever and a later
  // improvement to the keyword table would never reach this group.
  const [y, setY] = useState(entry.type);
  const label = entry.seg || ruleKey;
  const dirty = v !== entry.child_id || t.trim() !== entry.title || y !== entry.type;
  return (
    <div className="sub-rule">
      <span className="sub-rule-key">{label}</span>
      <select aria-label={`Child for ${label}`} value={v} onChange={(e) => setV(e.target.value)}>
        <option value="">— choose a child —</option>
        {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select aria-label={`Activity for ${label}`} value={y} onChange={(e) => setY(e.target.value)}>
        <option value="">Auto — {TYPES[defaultType]?.label || 'Other'}</option>
        <optgroup label="Transport">
          {Object.entries(TYPES).filter(([, x]) => x.trip).map(([k, x]) => (
            <option key={k} value={k}>{x.label}</option>
          ))}
        </optgroup>
        <optgroup label="Caregiving">
          {Object.entries(TYPES).filter(([, x]) => !x.trip).map(([k, x]) => (
            <option key={k} value={k}>{x.label}</option>
          ))}
        </optgroup>
      </select>
      <input
        type="text"
        className="sub-rule-title"
        aria-label={`Calendar title for ${label}`}
        value={t}
        placeholder={defaultTitle}
        maxLength={120}
        onChange={(e) => setT(e.target.value)}
      />
      <button className="btn" onClick={() => onSave(ruleKey, v, t, y)} disabled={busy || !v || !dirty}>
        Save
      </button>
    </div>
  );
}

// The editable half of a subscription row: label, activity and leg. Rendered BELOW the table, never
// inside a <td> — a text input plus two 16px touch-sized selects would widen .report-table and bury
// these controls behind sideways panning at 375px (the same reasoning as the routing rules below,
// and the failure kin.md records twice). Reuses .sub-rule, so the touch sizing in the
// (pointer: coarse) block already covers it.
function FeedEdit({ sub, busy, onSave, onCancel }) {
  const [label, setLabel] = useState(sub.label || '');
  const [type, setType] = useState(sub.type);
  const [pd, setPd] = useState(sub.pd || 'dropoff');
  const leg = takesLeg(type);
  const dirty =
    label.trim() !== (sub.label || '') || type !== sub.type || (leg && pd !== (sub.pd || 'dropoff'));
  return (
    <div className="sub-rule sub-edit">
      {/* Names the feed: the strip renders once BELOW a table that can be panned sideways, so with
          several subscriptions a constant heading leaves no tie to the row it edits — and a
          label-less feed renders '—' up there, so there is no content cue either. */}
      <span className="sub-rule-key">Feed settings — {sub.label || 'Calendar'}</span>
      <input
        type="text"
        className="sub-rule-title"
        aria-label="Subscription label"
        value={label}
        placeholder="e.g. Cobb County swim"
        maxLength={60}
        autoFocus
        onChange={(e) => setLabel(e.target.value)}
      />
      {/* Grouped like NameRule's, and for a stronger reason: picking a caregiving type nulls pd and
          strips the transport leg from every FUTURE import of this feed — a wider blast radius than
          NameRule's one title group. The '' sentinel stays bare at the end (it belongs to neither
          group), the way NameRule's "Auto —" sits outside its optgroups. */}
      <select
        aria-label="Activity for this feed"
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        <optgroup label="Transport">
          {Object.entries(TYPES).filter(([, x]) => x.trip).map(([k, x]) => (
            <option key={k} value={k}>{x.label}</option>
          ))}
        </optgroup>
        <optgroup label="Caregiving">
          {Object.entries(TYPES).filter(([, x]) => !x.trip).map(([k, x]) => (
            <option key={k} value={k}>{x.label}</option>
          ))}
        </optgroup>
        <option value="">— from title (match each title) —</option>
      </select>
      {leg && (
        <select aria-label="Leg for this feed" value={pd} onChange={(e) => setPd(e.target.value)}>
          <option value="dropoff">Drop-off</option>
          <option value="pickup">Pickup</option>
          <option value="both">Both</option>
        </select>
      )}
      <button
        className="btn"
        onClick={() => onSave({ label: label.trim(), type, pd: leg ? pd : null })}
        disabled={busy || !dirty}
      >
        Save
      </button>
      <button className="btn" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}

// A saved iCal feed subscription manager: an add form (URL + child/activity/parent mapping) and a
// list with per-row "Sync now" + Delete. Sync ADDS games not yet imported (dedup by uid+date on the
// server); it never edits or removes events you already have, so re-syncing is safe.
// A feed left on "per event" carries more than one kid: the server routes each event to a child by
// the name in its title and, when it can't, holds the event and lists its title group below for a
// one-time assignment.
function CalendarSubscriptions({ subscriptions, children, caregivers, onChanged, onAuthError }) {
  const activeChildren = children.filter((c) => !c.archived);
  const activeCaregivers = caregivers.filter((c) => !c.archived);
  const childName = (id) => children.find((c) => c.id === id)?.name || '—';
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [childId, setChildId] = useState(activeChildren[0]?.id || '');
  const [type, setType] = useState('sport');
  const [caregiverId, setCaregiverId] = useState('');
  const [pd, setPd] = useState('dropoff');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState('');
  const [saving, setSaving] = useState(false);
  const trip = takesLeg(type);
  const [editing, setEditing] = useState(''); // subscription id whose editor strip is open
  // Focus restore lives in the HOST, not FeedEdit: the strip is conditionally MOUNTED, so capturing
  // the opener inside it would run after autoFocus has already moved focus, and a restore in its
  // unmount cleanup fires once ON OPEN under StrictMode's setup→cleanup→setup. Capture in the click
  // handler, restore in an effect gated on the open flag. (kin.md client-state rule.)
  const editOpener = useRef(null);
  useEffect(() => {
    if (editing) return;
    const el = editOpener.current;
    editOpener.current = null;
    el?.focus();
  }, [editing]);

  async function saveFeed(sub, patch) {
    setSaving(true);
    try {
      const r = await familyReq(`/api/subscriptions/${sub.id}`, 'PUT', patch, onAuthError);
      if (r.ok) {
        // Close only if THIS feed's strip is still the open one. The row Edit buttons stay live
        // during a save, so an in-flight PUT on feed A resolving after the user opened feed B would
        // otherwise shut B's strip under them mid-typing.
        setEditing((cur) => (cur === sub.id ? '' : cur));
        await onChanged();
      }
    } finally {
      setSaving(false);
    }
  }

  async function sync(id, quiet) {
    setSyncing(id);
    const r = await familyReq(`/api/subscriptions/${id}/sync`, 'POST', {}, onAuthError);
    setSyncing('');
    if (r.ok) {
      if (!quiet) {
        const { added = 0, skipped = 0, pending = 0 } = r.data || {};
        alert(
          `Added ${added} new event${added === 1 ? '' : 's'}` +
            `${skipped ? `, skipped ${skipped} already imported` : ''}.` +
            `${pending ? ` ${pending} more need a child — assign them below.` : ''}`
        );
      }
      await onChanged();
    }
    return r;
  }

  async function add() {
    if (!url.trim()) return;
    setBusy(true);
    // An empty childId is the "per event" option: send null so the feed routes by title instead.
    const body = { label: label.trim(), url: url.trim(), child_id: childId || null, type, caregiver_id: caregiverId || '', pd: trip ? pd : null };
    const r = await familyReq('/api/subscriptions', 'POST', body, onAuthError);
    if (r.ok && r.data?.id) {
      const s = await sync(r.data.id, true); // first pull is silent — the row's status shows the result
      setLabel('');
      setUrl('');
      const { added = 0, pending = 0 } = s.data || {};
      if (s.ok) {
        alert(
          `Subscription added — imported ${added} event${added === 1 ? '' : 's'}.` +
            `${pending ? ` ${pending} more need a child — assign them below.` : ''}`
        );
      }
    }
    setBusy(false);
  }

  // Save one assignment, then pull immediately so the events it unblocks land without a second click.
  // Serialized behind `saving`: every Save PUTs the WHOLE map built from the client's snapshot, so two
  // in-flight saves on different rules would have the second clobber the first.
  async function assignRule(sub, key, child_id, title, type) {
    if (saving) return;
    setSaving(true);
    try {
      const map = parseChildMap(sub.child_map);
      const prev = ruleEntry(map[key]);
      // An empty title/type means "use the default" — persisting the computed default instead would
      // pin it forever, including for groups whose default is recomputed per event.
      const child_map = { ...map, [key]: { c: child_id, t: title.trim(), s: prev.seg, y: type } };
      const r = await familyReq(`/api/subscriptions/${sub.id}`, 'PUT', { child_map }, onAuthError);
      if (r.ok) await sync(sub.id); // sync() reports what landed and calls onChanged()
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    const r = await familyReq(`/api/subscriptions/${id}`, 'DELETE', undefined, onAuthError);
    if (r.ok) {
      // Deleting the feed being edited: clear the flag rather than leaving `editing` on a dead id.
      // Only after the delete lands — closing on the error path would drop the user's editor state
      // for a feed that still exists.
      if (id === editing) setEditing('');
      await onChanged();
    }
  }

  return (
    <>
      <div className="report-controls no-print sub-add">
        <label>
          Label
          <input type="text" value={label} placeholder="e.g. Ivy soccer" maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Calendar URL
          <input type="url" className="sub-url" value={url} placeholder="https://…/basic.ics or webcal://…" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          Child
          <select value={childId} onChange={(e) => setChildId(e.target.value)}>
            {activeChildren.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="">— per event (match the title) —</option>
          </select>
        </label>
        <label>
          Activity
          {/* Grouped like the editor strip's and NameRule's: the transport/caregiving line decides
              whether this feed's events carry a leg at all, so it should not be a flat list. */}
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <optgroup label="Transport">
              {Object.entries(TYPES).filter(([, x]) => x.trip).map(([k, x]) => (
                <option key={k} value={k}>{x.label}</option>
              ))}
            </optgroup>
            <optgroup label="Caregiving">
              {Object.entries(TYPES).filter(([, x]) => !x.trip).map(([k, x]) => (
                <option key={k} value={k}>{x.label}</option>
              ))}
            </optgroup>
            {/* Last and bare, mirroring the Child select's "— per event —": both mean "don't pin
                this, read it off each event". */}
            <option value="">— from title (match each title) —</option>
          </select>
        </label>
        <label>
          Transport parent
          <select value={caregiverId} onChange={(e) => setCaregiverId(e.target.value)}>
            <option value="">— none —</option>
            {activeCaregivers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {trip && (
          <label>
            Leg
            <select value={pd} onChange={(e) => setPd(e.target.value)}>
              <option value="dropoff">Drop-off</option>
              <option value="pickup">Pickup</option>
              <option value="both">Both</option>
            </select>
          </label>
        )}
        <button className="btn" onClick={add} disabled={busy || !url.trim()}>
          {busy ? 'Adding…' : '＋ Add subscription'}
        </button>
      </div>

      {subscriptions.length > 0 && (
        <div className="table-scroll">
          <table className="report-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Child</th>
                <th>Activity</th>
                <th>Last synced</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.id}>
                  <td className="rowlab">{s.label || '—'}</td>
                  <td>{s.child_id ? childName(s.child_id) : 'Per event'}</td>
                  {/* On a per-event feed a real type is only the FALLBACK — each group's own
                      activity wins — so labelling it plainly would misdescribe what the events
                      actually got. In from-title mode nothing is a default, so no suffix. */}
                  <td>
                    {s.type === ''
                      ? 'From title'
                      : `${TYPES[s.type]?.label || s.type}${s.child_id ? '' : ' (default)'}`}
                  </td>
                  <td>
                    {s.last_synced_at
                      ? `${fmtRecorded(s.last_synced_at)}${s.last_status && s.last_status !== 'ok' ? ` — ${s.last_status}` : ''}`
                      : 'Never'}
                  </td>
                  <td className="sub-actions">
                    <button
                      className="btn"
                      onClick={(e) => {
                        editOpener.current = e.currentTarget;
                        setEditing(editing === s.id ? '' : s.id);
                      }}
                    >
                      {editing === s.id ? 'Close' : 'Edit'}
                    </button>
                    <button className="btn" onClick={() => sync(s.id)} disabled={syncing === s.id}>
                      {syncing === s.id ? 'Syncing…' : 'Sync now'}
                    </button>
                    <button className="btn btn-del" onClick={() => remove(s.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* keyed by id so switching rows remounts with that feed's values instead of stale state */}
      {subscriptions.some((s) => s.id === editing) && (
        <FeedEdit
          key={editing}
          sub={subscriptions.find((s) => s.id === editing)}
          busy={saving || syncing === editing}
          onSave={(patch) => saveFeed(subscriptions.find((s) => s.id === editing), patch)}
          onCancel={() => setEditing('')}
        />
      )}

      {/* Routing rules for per-event feeds. Deliberately OUTSIDE .table-scroll: putting these
          controls in a <td> would widen the table — two 16px touch-sized selects plus a text input
          per row — and bury them behind sideways panning at 375px. */}
      {subscriptions.map((s) => {
        const map = parseChildMap(s.child_map);
        // "Assigned" means assigned to a child who is still ACTIVE — the same predicate routeTitle
        // uses at sync time. A rule pointing at a since-archived child stops resolving and its events
        // go back to the review list, so counting it as assigned here would leave the disclosure
        // collapsed and claim nothing needs a child while the row above says otherwise.
        const assigned = (e) => activeChildren.some((c) => c.id === e.child_id);
        const rules = Object.entries(map)
          .map(([k, v]) => [k, ruleEntry(v)])
          .sort(([, a], [, b]) => (assigned(a) ? 1 : 0) - (assigned(b) ? 1 : 0));
        if (!rules.length) return null;
        const waiting = rules.filter(([, e]) => !assigned(e)).length;
        return (
          <details key={s.id} className="sub-rules" open={waiting > 0}>
            <summary>
              {s.label || 'Calendar'} — who is who
              {waiting ? ` (${waiting} need${waiting === 1 ? 's' : ''} a child)` : ''}
            </summary>
            <p className="report-note">
              Each row is a group of events that share a title. Pick the child, and if you like a
              shorter name and a different activity — then every future sync files them for you.
              Activity defaults to a guess from the title. Changes apply to events imported from then
              on; events already on your calendar keep the child, title and activity they were filed
              under.
            </p>
            {rules.map(([k, e]) => {
              const namesChild = activeChildren.some((c) => hasName(e.seg || k, c.name));
              return (
                <NameRule
                  key={`${k}:${e.child_id}:${e.title}:${e.type}`}
                  ruleKey={k}
                  entry={e}
                  options={activeChildren}
                  // What the title becomes if the box is left empty. When the segment names a child
                  // it gets stripped per event, so there is no single name to suggest.
                  defaultTitle={namesChild ? 'kept from each event title' : e.seg || k}
                  // What the activity becomes if left on Auto — a keyword guess from the segment,
                  // but only when the segment isn't a name prefix AND the feed's own type is
                  // trip-typed (guessing on a non-trip feed would flip trip-ness and invent a
                  // transport leg) or is the '' from-title sentinel; else the feed's own type, and
                  // 'other' when that is '' too. Mirrors routeTitle EXACTLY (lib/ical-map.js) —
                  // including the '' branch and the `other` resort. A divergence here shows the user
                  // a different guess than the one that actually gets imported.
                  defaultType={
                    (!namesChild && (s.type === '' || isTrip(s.type)) && guessType(e.seg || k)) ||
                    s.type ||
                    'other'
                  }
                  busy={saving || syncing === s.id}
                  onSave={(key, child_id, title, type) => assignRule(s, key, child_id, title, type)}
                />
              );
            })}
          </details>
        );
      })}
    </>
  );
}

export default function Settings() {
  const router = useRouter();
  const [tokens, setTokens] = useState([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(null); // { token, url } — shown once, never stored
  const [loading, setLoading] = useState(true);
  const [children, setChildren] = useState([]);
  const [caregivers, setCaregivers] = useState([]);
  const [famOk, setFamOk] = useState(false); // children + caregivers both loaded
  const [subscriptions, setSubscriptions] = useState([]);
  const [subOk, setSubOk] = useState(false); // calendar subscriptions loaded
  const [schedules, setSchedules] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [ptOpen, setPtOpen] = useState(false);
  const ptOpenerRef = useRef(null); // restore focus here when the modal closes
  const [ptOk, setPtOk] = useState(false); // both parent-time fetches succeeded
  const [showParentTime, setShowParentTime] = useState(true);
  const [origin, setOrigin] = useState(''); // this deployment's own origin, for the setup snippets

  const goToLogin = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* best effort */
    }
    router.replace('/login');
  }, [router]);

  const load = useCallback(async () => {
    try {
      // Each fetch .catch-es to a sentinel so one section failing doesn't blank the others
      // (kin.md data-fetch rule). children/caregivers come from their own endpoints (full
      // rosters incl. archived) so the Family manager and the parent-time gate stay accurate.
      const [tokRes, chRes, cgRes, schRes, subRes] = await Promise.all([
        fetch('/api/mcp-tokens', { cache: 'no-store' }).catch(() => ({ ok: false })),
        fetch('/api/children', { cache: 'no-store' }).catch(() => ({ ok: false })),
        fetch('/api/caregivers', { cache: 'no-store' }).catch(() => ({ ok: false })),
        fetch('/api/schedules', { cache: 'no-store' }).catch(() => ({ ok: false })),
        fetch('/api/subscriptions', { cache: 'no-store' }).catch(() => ({ ok: false })),
      ]);
      if ([tokRes, chRes, cgRes, schRes, subRes].some((r) => r.status === 401)) {
        await goToLogin();
        return;
      }
      // Clear on failure rather than leaving stale values — after a revoke that then fails
      // to refresh, showing the old "Active" row would be misleading (kin.md data-fetch rule).
      if (tokRes.ok) setTokens((await tokRes.json()).tokens || []);
      else setTokens([]);
      if (chRes.ok) setChildren((await chRes.json()).children || []);
      else setChildren([]);
      if (cgRes.ok) setCaregivers((await cgRes.json()).caregivers || []);
      else setCaregivers([]);
      setFamOk(!!(chRes.ok && cgRes.ok));
      if (subRes.ok) setSubscriptions((await subRes.json()).subscriptions || []);
      else setSubscriptions([]);
      setSubOk(!!subRes.ok);
      if (schRes.ok) {
        const s = await schRes.json();
        setSchedules(s.schedules || []);
        setOverrides(s.overrides || []);
      } else {
        setSchedules([]);
        setOverrides([]);
      }
      // Gate the manager on BOTH fetches: opening it with schedules cleared to [] after a
      // failed fetch would look like "no rotation configured" and invite a duplicate that
      // silently shadows the real one (newest-created_at wins in lib/schedule.js).
      setPtOk(!!(cgRes.ok && schRes.ok));
    } catch {
      setTokens([]);
      setChildren([]);
      setCaregivers([]);
      setFamOk(false);
      setSubscriptions([]);
      setSubOk(false);
      setSchedules([]);
      setOverrides([]);
      setPtOk(false);
    } finally {
      setLoading(false);
    }
  }, [goToLogin]);

  useEffect(() => {
    load();
  }, [load]);

  // The setup snippets embed this deployment's origin (kin.example.com in prod, localhost:3001 in
  // dev). Read it post-mount so the SSR render and the first client render agree (both start '').
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // The calendar reads this on mount; the toggle itself lives here (client-only pref,
  // read in an effect so the server render matches the default).
  useEffect(() => {
    const v = window.localStorage.getItem('kin.showParentTime');
    if (v != null) setShowParentTime(v === '1');
  }, []);

  // Restore focus to the opener when the modal closes. Captured in the click
  // handler (an effect-time read would be too late — autoFocus has already moved
  // focus into the modal during commit); the cleanup only exists while open, so
  // StrictMode's mount double-invoke can't fire it spuriously (Calendar pattern).
  useEffect(() => {
    if (!ptOpen) return;
    return () => {
      const t = ptOpenerRef.current;
      if (t && typeof t.focus === 'function') t.focus();
    };
  }, [ptOpen]);

  function toggleParentTime(checked) {
    setShowParentTime(checked);
    window.localStorage.setItem('kin.showParentTime', checked ? '1' : '0');
  }

  async function logout() {
    await goToLogin();
    router.refresh();
  }

  async function create() {
    setBusy(true);
    setFresh(null);
    try {
      const res = await fetch('/api/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (res.status === 401) {
        await goToLogin();
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(d.error || 'Could not create token');
        return;
      }
      setFresh({ token: d.token }); // shown once — the raw token is never stored
      setLabel('');
      await load();
    } catch {
      alert('Network error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id) {
    try {
      const res = await fetch(`/api/mcp-tokens/${id}`, { method: 'DELETE' });
      if (res.status === 401) {
        await goToLogin();
        return;
      }
      await load();
    } catch {
      alert('Network error');
    }
  }

  const activeCaregivers = caregivers.filter((c) => !c.archived);

  // Snippet inputs: a freshly-minted token fills the snippets in place; otherwise a placeholder.
  const base = origin || 'https://your-kin-host';
  const tok = fresh?.token || 'YOUR_TOKEN';
  // Built from THIS browser's origin (+ the real token once minted) — never the server's
  // request origin, which behind the proxy is the container's internal 0.0.0.0:3000 bind.
  const linkUrl = `${base}/api/link/${tok}/mcp`;

  return (
    <div className="report">
      <div className="report-controls no-print">
        <a className="btn" href="/">‹ Calendar</a>
      </div>

      <h1>Settings</h1>

      <h2 className="report-h2">Calendar display</h2>
      {/* Standalone label, NOT inside .report-controls — its input rule would restyle
          the checkbox (border/padding meant for text inputs). */}
      <label className="pt-toggle" title="Show the parent-on-duty overlay">
        <input
          type="checkbox"
          checked={showParentTime}
          onChange={(e) => toggleParentTime(e.target.checked)}
        />
        Show parent time on calendar
      </label>

      <h2 className="report-h2">Family</h2>
      <p className="report-note">
        The children and parents tracked on the calendar. Rename or recolor to update everywhere;
        archive to hide someone from new events without touching past records (they still appear on
        historical events and reports). Archiving the last active member isn’t allowed.
      </p>
      {!loading && !famOk && (
        <p className="report-note">Couldn’t load family — reload to try again.</p>
      )}
      {famOk && (
        <>
          <h3 className="family-sub">Children</h3>
          <FamilyManager noun="child" endpoint="children" rows={children} onChanged={load} onAuthError={goToLogin} />
          <h3 className="family-sub">Parents</h3>
          <FamilyManager noun="parent" endpoint="caregivers" rows={caregivers} onChanged={load} onAuthError={goToLogin} />
        </>
      )}

      <h2 className="report-h2">Parent time</h2>
      <p className="report-note">
        Base rotations and holiday/summer overrides. (Parent names &amp; colors live in Family, above.)
      </p>
      {!loading && !(ptOk && activeCaregivers.length > 0) && (
        <p className="report-note">
          {ptOk
            ? 'Add a parent under Family to set up parent-time rotations.'
            : 'Couldn’t load parent-time data — reload to try again.'}
        </p>
      )}
      {ptOk && activeCaregivers.length > 0 && (
        <div className="report-controls no-print">
          <button
            className="btn"
            onClick={(e) => {
              ptOpenerRef.current = e.currentTarget;
              setPtOpen(true);
            }}
          >
            ⧉ Manage parent time
          </button>
        </div>
      )}

      <h2 className="report-h2">Calendar subscriptions</h2>
      <p className="report-note">
        Subscribe to an external calendar — a team&rsquo;s <code>.ics</code>{' '}or webcal link — and pull
        its events in as activities. Pick a child to file every event under that one kid, or choose{' '}
        <strong>per event</strong> when the feed covers both — Kin then matches each event by its title
        and asks you once about anything it can&rsquo;t place. &ldquo;Sync now&rdquo; adds any events not
        already imported; it never edits or removes events you already have, so syncing again is safe.
        There is no automatic background sync.
      </p>
      {!loading && !famOk && (
        <p className="report-note">Add a child under Family first to subscribe to a calendar.</p>
      )}
      {famOk && !subOk && (
        <p className="report-note">Couldn&rsquo;t load subscriptions — reload to try again.</p>
      )}
      {famOk && subOk && (
        <CalendarSubscriptions
          subscriptions={subscriptions}
          children={children}
          caregivers={caregivers}
          onChanged={load}
          onAuthError={goToLogin}
        />
      )}

      <h2 className="report-h2">Agent access (MCP)</h2>
      <p className="report-note">
        Mint a token per AI agent so each can read the calendar — events and the on-duty
        parent — and log events over MCP. A token can’t change custody schedules, seal months,
        or create share links; those stay in the app. A token never expires; revoke it here
        anytime. Rotating <code>AUTH_SECRET</code> invalidates all minted tokens.
      </p>
      <div className="report-controls no-print">
        <label>
          Label
          <input
            type="text"
            value={label}
            placeholder="e.g. Claude Code laptop"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <button className="btn" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : '🔑 Create token'}
        </button>
      </div>

      {fresh && (
        <div className="seal-status ok">
          Token created — copy it now, it won’t be shown again.
          <div className="copy-field">
            <span className="cf-label">
              Bearer token (Claude Code / <code>.mcp.json</code>, header auth for <code>/api/mcp</code>):
            </span>
            <div className="copy-row">
              <input
                className="share-url"
                readOnly
                aria-label="MCP bearer token"
                value={fresh.token}
                onFocus={(e) => e.target.select()}
              />
              <CopyButton text={fresh.token} />
            </div>
          </div>
          <div className="copy-field">
            <span className="cf-label">
              Connector URL (claude.ai — the token is the credential, keep the URL private):
            </span>
            <div className="copy-row">
              <input
                className="share-url"
                readOnly
                aria-label="MCP connector URL"
                value={linkUrl}
                onFocus={(e) => e.target.select()}
              />
              <CopyButton text={linkUrl} />
            </div>
          </div>
        </div>
      )}

      <div className="mcp-setup">
        <p className="report-note">
          Connect your agent — expand one and copy the snippet
          {fresh ? ' (your new token is filled in)' : ' (replace YOUR_TOKEN with a token above)'}.
        </p>

        <details className="setup-agent">
          <summary>Claude Code</summary>
          <p className="setup-hint">Terminal (recommended):</p>
          <Snippet code={`claude mcp add --transport http kin ${base}/api/mcp \\\n  --header "Authorization: Bearer ${tok}"`} />
          <p className="setup-hint">Or add to <code>.mcp.json</code>:</p>
          <Snippet
            code={`{\n  "mcpServers": {\n    "kin": {\n      "type": "http",\n      "url": "${base}/api/mcp",\n      "headers": { "Authorization": "Bearer ${tok}" }\n    }\n  }\n}`}
          />
        </details>

        <details className="setup-agent">
          <summary>Claude Desktop</summary>
          <p className="setup-hint">
            Custom connector (Settings → Connectors → Add custom connector) — paste this URL (the
            token is in the URL, so keep it private):
          </p>
          <Snippet code={linkUrl} />
          <p className="setup-hint">
            Or in <code>claude_desktop_config.json</code> — the desktop config file only takes stdio
            servers, so bridge with mcp-remote:
          </p>
          <Snippet
            code={`{\n  "mcpServers": {\n    "kin": {\n      "command": "npx",\n      "args": ["mcp-remote", "${base}/api/mcp", "--header", "Authorization: Bearer ${tok}"]\n    }\n  }\n}`}
          />
        </details>

        <details className="setup-agent">
          <summary>Codex</summary>
          <p className="setup-hint">Add to <code>~/.codex/config.toml</code>:</p>
          <Snippet code={`[mcp_servers.kin]\nurl = "${base}/api/mcp"\nbearer_token_env_var = "KIN_MCP_TOKEN"`} />
          <p className="report-note">
            Set <code>KIN_MCP_TOKEN</code>{' '}to the token in Codex&rsquo;s shell environment. Older
            Codex builds also need <code>experimental_use_rmcp_client = true</code>{' '}at the top of
            the file.
          </p>
        </details>

        <details className="setup-agent">
          <summary>ChatGPT</summary>
          <p className="setup-hint">
            Developer mode → Settings → Connectors → add a connector, paste this URL (Authentication:
            None; the token is in the URL):
          </p>
          <Snippet code={linkUrl} />
          <p className="report-note">
            Requires a paid plan with developer mode enabled; write actions ask for confirmation each
            time.
          </p>
        </details>

        <details className="setup-agent">
          <summary>Other agents</summary>
          <p className="setup-hint">
            claude.ai / connectors without header support — paste this URL (the token is in the URL,
            so keep it private):
          </p>
          <Snippet code={linkUrl} />
          <p className="setup-hint">A stdio-only client — bridge it with mcp-remote:</p>
          <Snippet code={`npx mcp-remote ${base}/api/mcp --header "Authorization: Bearer ${tok}"`} />
        </details>
      </div>

      {!loading && tokens.length === 0 && !fresh && (
        <p className="report-note">No agent tokens yet.</p>
      )}
      {tokens.length > 0 && (
        <div className="table-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td className="rowlab">{t.label || '—'}</td>
                <td>{fmtRecorded(t.created_at)}</td>
                <td>{t.last_used_at ? fmtRecorded(t.last_used_at) : 'Never'}</td>
                <td>{t.revoked ? 'Revoked' : 'Active'}</td>
                <td>
                  {!t.revoked && (
                    <button className="btn btn-del" onClick={() => revoke(t.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h2 className="report-h2">Session</h2>
      <div className="report-controls no-print">
        <button className="btn" onClick={logout}>Log out</button>
      </div>

      {ptOpen && ptOk && activeCaregivers.length > 0 && (
        <ScheduleManager
          caregivers={caregivers}
          schedules={schedules}
          overrides={overrides}
          onClose={() => setPtOpen(false)}
          onChange={load}
          onAuthError={goToLogin}
        />
      )}
    </div>
  );
}

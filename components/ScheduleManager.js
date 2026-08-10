'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  PRESETS,
  resolvePreset,
  splitPercent,
  parentOnDate,
  parseYmd,
  ymdLocal as ymd,
} from '@/lib/schedule';
import { trapTab } from '@/lib/trap-tab';
import { HOLIDAYS, nextHolidayRange } from '@/lib/holidays';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CYCLE_CHOICES = [7, 14, 21, 28];

const addDays = (s, n) => {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const fmtRange = (a, b) =>
  !a && !b ? 'Always' : `${a || '…'} → ${b || '…'}`;

// `active` is the list of ACTIVE parents — a new rotation always defaults to active parents.
function emptyDraft(active) {
  return {
    id: null,
    label: '',
    preset_key: 'week_on_off',
    parentA: active[0]?.id || '',
    parentB: active[1]?.id || active[0]?.id || '',
    anchor_date: ymd(new Date()),
    seasonal: false,
    starts_on: '',
    ends_on: '',
    customLen: 14,
    // custom pattern of 'A'/'B' tokens, length === customLen
    custom: Array.from({ length: 14 }, () => 'A'),
    wasMulti: false, // set when loading a schedule that used more than two distinct parents
  };
}

// Rebuild editor state from a saved schedule row (assignment is a JSON string of ids).
function draftFromSchedule(s, active) {
  const assignment = Array.isArray(s.assignment) ? s.assignment : JSON.parse(s.assignment);
  let parentA = active[0]?.id || '';
  let parentB = active[1]?.id || parentA;
  let custom = Array.from({ length: assignment.length }, () => 'A');
  if (s.preset_key && PRESETS[s.preset_key]) {
    const pat = PRESETS[s.preset_key].pattern;
    const ai = pat.indexOf('A');
    const bi = pat.indexOf('B');
    if (ai >= 0) parentA = assignment[ai];
    if (bi >= 0) parentB = assignment[bi];
  } else {
    // custom: first distinct id = A, the other = B
    const distinct = [...new Set(assignment)];
    parentA = distinct[0] || parentA;
    parentB = distinct[1] || active.find((c) => c.id !== parentA)?.id || parentA;
    custom = assignment.map((id) => (id === parentA ? 'A' : 'B'));
  }
  return {
    id: s.id,
    label: s.label || '',
    preset_key: s.preset_key || 'custom',
    parentA,
    parentB,
    anchor_date: s.anchor_date,
    seasonal: !!(s.starts_on || s.ends_on),
    starts_on: s.starts_on || '',
    ends_on: s.ends_on || '',
    customLen: assignment.length,
    custom,
    // The A/B editor can only hold two parents; if this rotation used more, saving collapses
    // it — warn (not block) so the rewrite is informed, not silent.
    wasMulti: new Set(assignment).size > 2,
  };
}

export default function ScheduleManager({
  caregivers,
  schedules,
  overrides,
  onClose,
  onChange,
  onAuthError,
}) {
  // Only ACTIVE parents can be written into a rotation/override; names of ALL parents (incl.
  // archived) still resolve for display of existing schedules/overrides. (Parent add/rename/
  // recolor/archive now lives in Settings → Family, not here.)
  const active = caregivers.filter((c) => !c.archived);
  const activeIds = new Set(active.map((c) => c.id));

  const [draft, setDraft] = useState(() => emptyDraft(active));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ov, setOv] = useState({
    label: '',
    date_from: ymd(new Date()),
    date_to: ymd(new Date()),
    caregiver_id: active[0]?.id || '',
  });

  const cgName = (id) => caregivers.find((c) => c.id === id)?.name || '?';

  // A/B <select> options: the active parents, plus the currently-selected value if it happens
  // to be archived (from an old rotation) so the control isn't stuck on an invalid value —
  // labelled so the user knows to reassign it.
  const optionsFor = (currentId) => {
    const opts = active.map((c) => ({ id: c.id, name: c.name }));
    if (currentId && !activeIds.has(currentId)) {
      opts.push({ id: currentId, name: `${cgName(currentId)} (archived)` });
    }
    return opts;
  };
  // Block the save when a chosen parent is archived (the server would 400); warn (allow) when
  // an edited rotation originally spanned >2 parents (saving keeps the two shown).
  const archivedPicked =
    (!!draft.parentA && !activeIds.has(draft.parentA)) ||
    (!!draft.parentB && !activeIds.has(draft.parentB));

  // Focus restore lives in the HOST (Settings) — an in-component mount-effect
  // cleanup would fire once on open under dev StrictMode's double-invoke and
  // yank focus back behind the overlay.

  // Escape closes — but never mid-save (matching the overlay-click guard) and
  // never when defaultPrevented (e.g. dismissing an open native <select> picker).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // Resolve the draft into an assignment array of caregiver ids + cycle length.
  const resolved = useMemo(() => {
    if (draft.preset_key === 'custom') {
      const assignment = draft.custom.map((t) => (t === 'A' ? draft.parentA : draft.parentB));
      return { assignment, cycle_len: draft.custom.length };
    }
    const p = PRESETS[draft.preset_key];
    return { assignment: resolvePreset(draft.preset_key, draft.parentA, draft.parentB), cycle_len: p.cycleLen };
  }, [draft]);

  // 14-day preview from the anchor, using the draft's resolved cycle (no seasonal bounds
  // so the raw rotation is visible).
  const preview = useMemo(() => {
    const sched = [
      {
        id: 'preview',
        assignment: resolved.assignment,
        cycle_len: resolved.cycle_len,
        anchor_date: draft.anchor_date,
        starts_on: null,
        ends_on: null,
        created_at: '',
      },
    ];
    const days = [];
    const n = Math.max(14, resolved.cycle_len); // show the full cycle for 21/28-day customs
    for (let i = 0; i < n; i++) {
      const ds = addDays(draft.anchor_date, i);
      const id = parentOnDate(ds, sched, []);
      days.push({ ds, id });
    }
    return days;
  }, [resolved, draft.anchor_date]);

  const split = useMemo(() => splitPercent(resolved.assignment), [resolved]);

  function setCustomLen(len) {
    setDraft((d) => {
      const custom = Array.from({ length: len }, (_, i) => d.custom[i] || 'A');
      return { ...d, customLen: len, custom };
    });
  }
  function toggleCustomDay(i) {
    setDraft((d) => {
      const custom = d.custom.slice();
      custom[i] = custom[i] === 'A' ? 'B' : 'A';
      return { ...d, custom };
    });
  }

  async function send(url, method, body) {
    setBusy(true);
    setErr('');
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      setBusy(false);
      setErr('Network error');
      return false;
    }
    setBusy(false);
    if (res.ok) {
      await onChange();
      return true;
    }
    if (res.status === 401) {
      await onAuthError();
      return false;
    }
    const d = await res.json().catch(() => ({}));
    setErr(d.error || 'Save failed');
    return false;
  }

  async function saveSchedule() {
    const body = {
      label: draft.label,
      preset_key: draft.preset_key,
      cycle_len: resolved.cycle_len,
      assignment: resolved.assignment,
      anchor_date: draft.anchor_date,
      starts_on: draft.seasonal && draft.starts_on ? draft.starts_on : null,
      ends_on: draft.seasonal && draft.ends_on ? draft.ends_on : null,
    };
    const ok = await send(
      draft.id ? `/api/schedules/${draft.id}` : '/api/schedules',
      draft.id ? 'PUT' : 'POST',
      body
    );
    if (ok) setDraft(emptyDraft(active));
  }

  async function delSchedule(id) {
    await send(`/api/schedules/${id}`, 'DELETE');
    if (draft.id === id) setDraft(emptyDraft(active));
  }

  async function addOverride() {
    const ok = await send('/api/overrides', 'POST', ov);
    if (ok)
      setOv({
        label: '',
        date_from: ymd(new Date()),
        date_to: ymd(new Date()),
        caregiver_id: active[0]?.id || '',
      });
  }

  return (
    <div className="overlay" onClick={(e) => e.target.classList.contains('overlay') && !busy && onClose()}>
      <div className="modal pt-modal" role="dialog" aria-modal="true" aria-labelledby="pt-title" onKeyDown={trapTab}>
        <h2 id="pt-title">Parent time</h2>
        {err && <div className="err">{err}</div>}

        {/* ── Rotation ───────────────────────────────────────────── */}
        <h3 className="pt-h3">Rotation</h3>
        {schedules.length > 0 && (
          <ul className="pt-list">
            {schedules.map((s) => {
              const sp = splitPercent(
                Array.isArray(s.assignment) ? s.assignment : JSON.parse(s.assignment)
              );
              const pctTxt = Object.entries(sp.pct)
                .map(([id, p]) => `${cgName(id)} ${p}%`)
                .join(' · ');
              return (
                <li key={s.id} className="pt-row">
                  <span className="pt-row-main">
                    <strong>{s.label || PRESETS[s.preset_key]?.label || s.preset_key}</strong>
                    <span className="pt-muted">
                      {fmtRange(s.starts_on, s.ends_on)} · {pctTxt}
                    </span>
                  </span>
                  <span className="pt-row-actions">
                    <button className="bf-link" onClick={() => setDraft(draftFromSchedule(s, active))}>
                      Edit
                    </button>
                    <button className="bf-link pt-del" onClick={() => delSchedule(s.id)} disabled={busy}>
                      Delete
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <div className="pt-editor">
          <div className="pt-editor-head">{draft.id ? 'Edit schedule' : 'New schedule'}</div>
          <div className="field">
            <label>Label (optional)</label>
            {/* autoFocus: move focus into the aria-modal on open so the focus order
                starts inside it (kin.md rule — matches the edit/backfill modals). */}
            <input
              autoFocus
              value={draft.label}
              placeholder="e.g. School year, Summer"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Pattern</label>
            <select
              value={draft.preset_key}
              onChange={(e) => {
                const preset_key = e.target.value;
                setDraft((d) => {
                  // Switching to Custom from a non-standard cycle length (e.g. alt_two's 4)
                  // would leave the cycle-length radios with nothing selected — snap to 14.
                  if (preset_key === 'custom' && !CYCLE_CHOICES.includes(d.customLen)) {
                    const custom = Array.from({ length: 14 }, (_, i) => d.custom[i] || 'A');
                    return { ...d, preset_key, customLen: 14, custom };
                  }
                  return { ...d, preset_key };
                });
              }}
            >
              {Object.entries(PRESETS).map(([k, p]) => (
                <option key={k} value={k}>{p.label}</option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </div>
          <div className="row2">
            <div className="field">
              <label>First parent (A)</label>
              <select value={draft.parentA} onChange={(e) => setDraft({ ...draft, parentA: e.target.value })}>
                {optionsFor(draft.parentA).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Second parent (B)</label>
              <select value={draft.parentB} onChange={(e) => setDraft({ ...draft, parentB: e.target.value })}>
                {optionsFor(draft.parentB).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>
          {archivedPicked && (
            <div className="pt-warn">
              An archived parent is selected — pick active parents (manage them in Settings → Family)
              before saving.
            </div>
          )}
          {!archivedPicked && draft.wasMulti && (
            <div className="pt-warn">
              This rotation was built with more than two parents, which this two-parent editor can’t
              represent — saving here would drop a parent from future on-duty dates. Delete it and
              rebuild instead.
            </div>
          )}

          {draft.preset_key === 'custom' && (
            <div className="field">
              <label>Custom cycle</label>
              <div className="seg pt-cyclelen">
                {CYCLE_CHOICES.map((n) => (
                  <label key={n}>
                    <input
                      type="radio"
                      name="cyclelen"
                      checked={draft.customLen === n}
                      onChange={() => setCustomLen(n)}
                    />
                    <span>{n}d</span>
                  </label>
                ))}
              </div>
              <div className="pt-grid">
                {draft.custom.map((t, i) => (
                  <button
                    type="button"
                    key={i}
                    className={`pt-daybtn ${t === 'A' ? 'a' : 'b'}`}
                    onClick={() => toggleCustomDay(i)}
                    title={`Day ${i + 1}`}
                  >
                    {t === 'A' ? cgName(draft.parentA)[0] : cgName(draft.parentB)[0]}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <label>Cycle starts on (anchor)</label>
            <input
              type="date"
              value={draft.anchor_date}
              onChange={(e) => setDraft({ ...draft, anchor_date: e.target.value })}
            />
          </div>

          <label className="pt-check">
            <input
              type="checkbox"
              checked={draft.seasonal}
              onChange={(e) => setDraft({ ...draft, seasonal: e.target.checked })}
            />
            Limit to a date range (e.g. summer)
          </label>
          {draft.seasonal && (
            <div className="row2">
              <div className="field">
                <label>From</label>
                <input
                  type="date"
                  value={draft.starts_on}
                  onChange={(e) => setDraft({ ...draft, starts_on: e.target.value })}
                />
              </div>
              <div className="field">
                <label>To</label>
                <input
                  type="date"
                  value={draft.ends_on}
                  onChange={(e) => setDraft({ ...draft, ends_on: e.target.value })}
                />
              </div>
            </div>
          )}

          <div className="pt-split">
            {Object.entries(split.pct).map(([id, p]) => (
              <span key={id} className="pt-split-item">
                <span
                  className="swatch"
                  style={{ background: caregivers.find((c) => c.id === id)?.color || '#999' }}
                />
                {cgName(id)} ≈ {p}%
              </span>
            ))}
          </div>
          <div className="pt-preview">
            {preview.map((d, i) => {
              const c = caregivers.find((x) => x.id === d.id);
              return (
                <span
                  key={i}
                  className="pt-prevday"
                  style={{ background: c ? c.color + '33' : 'transparent', borderColor: c?.color || 'var(--line)' }}
                  title={d.ds}
                >
                  {WD[parseYmd(d.ds).getDay()]}
                  <em>{c ? c.name[0] : '?'}</em>
                </span>
              );
            })}
          </div>

          <div className="modal-actions">
            {draft.id && (
              <button className="btn" onClick={() => setDraft(emptyDraft(active))} disabled={busy}>
                Cancel edit
              </button>
            )}
            <button
              className="btn btn-save"
              onClick={saveSchedule}
              disabled={busy || archivedPicked || draft.wasMulti}
            >
              {draft.id ? 'Save changes' : 'Add schedule'}
            </button>
          </div>
        </div>

        {/* ── Holidays & overrides ───────────────────────────────── */}
        <h3 className="pt-h3">Holidays &amp; overrides</h3>
        {overrides.length > 0 && (
          <ul className="pt-list">
            {overrides.map((o) => (
              <li key={o.id} className="pt-row">
                <span className="pt-row-main">
                  <strong>{o.label || 'Override'}</strong>
                  <span className="pt-muted">
                    {o.date_from === o.date_to ? o.date_from : `${o.date_from} → ${o.date_to}`} ·{' '}
                    {cgName(o.caregiver_id)}
                  </span>
                </span>
                <span className="pt-row-actions">
                  <button
                    className="bf-link pt-del"
                    onClick={() => send(`/api/overrides/${o.id}`, 'DELETE')}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="pt-editor">
          <div className="field">
            <label>Common holiday (optional)</label>
            {/* Action picker: fills label + dates for the next occurrence, then snaps back to the
                placeholder (value is always ''); the dates stay editable below. */}
            <select
              value=""
              onChange={(e) => {
                const r = e.target.value && nextHolidayRange(e.target.value, ymd(new Date()));
                if (r) setOv({ ...ov, label: r.label, date_from: r.from, date_to: r.to });
              }}
            >
              <option value="">— pick to fill the dates —</option>
              {HOLIDAYS.map((h) => (
                <option key={h.key} value={h.key}>{h.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Label</label>
            <input
              value={ov.label}
              placeholder="e.g. Thanksgiving, Spring break"
              onChange={(e) => setOv({ ...ov, label: e.target.value })}
            />
          </div>
          <div className="row2">
            <div className="field">
              <label>From</label>
              <input type="date" value={ov.date_from} onChange={(e) => setOv({ ...ov, date_from: e.target.value })} />
            </div>
            <div className="field">
              <label>To</label>
              <input type="date" value={ov.date_to} onChange={(e) => setOv({ ...ov, date_to: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Parent</label>
            <select value={ov.caregiver_id} onChange={(e) => setOv({ ...ov, caregiver_id: e.target.value })}>
              {active.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="modal-actions">
            <button className="btn btn-save" onClick={addOverride} disabled={busy}>
              Add override
            </button>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

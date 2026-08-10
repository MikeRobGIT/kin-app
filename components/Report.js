'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TYPES, PD, isTrip } from '@/lib/constants';
import { overnightCounts, ymdLocal as ymd } from '@/lib/schedule';
import { summarizeInvolvement, UNASSIGNED } from '@/lib/report';
import { fmtRecorded } from '@/lib/format';

const pad = (n) => String(n).padStart(2, '0'); // still needed for HH:MM formatting

function defaultRange() {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 6);
  return { from: ymd(from), to: ymd(to) };
}
function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
function fmtTime(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'a' : 'p';
  h = h % 12 || 12;
  return `${h}:${pad(m)}${ap}`;
}

export default function Report() {
  const router = useRouter();
  const init = defaultRange();
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [childId, setChildId] = useState('');
  const [data, setData] = useState({ events: [], children: [], caregivers: [] });
  const [schedules, setSchedules] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [seals, setSeals] = useState([]);
  const [monthSel, setMonthSel] = useState(() => ymd(new Date()).slice(0, 7));
  const [sealBusy, setSealBusy] = useState(false);
  const [sealStatus, setSealStatus] = useState(null); // latest verify result for monthSel
  const [shareTokens, setShareTokens] = useState([]);
  const [shareLabel, setShareLabel] = useState('');
  const [shareDays, setShareDays] = useState(30);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState(''); // freshly-minted link, shown once
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generatedAt, setGeneratedAt] = useState('');

  const goToLogin = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* best effort */
    }
    router.replace('/login');
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [evRes, schRes, sealRes, shareRes] = await Promise.all([
        fetch(`/api/events?from=${from}&to=${to}`, { cache: 'no-store' }),
        // Optional: a schedule/seals fetch failure (reject OR non-OK) must not fail the report.
        fetch('/api/schedules', { cache: 'no-store' }).catch(() => ({ ok: false })),
        fetch('/api/seals', { cache: 'no-store' }).catch(() => ({ ok: false })),
        fetch('/api/share', { cache: 'no-store' }).catch(() => ({ ok: false })),
      ]);
      if (evRes.status === 401 || schRes.status === 401) {
        await goToLogin();
        return;
      }
      if (!evRes.ok) throw new Error('Failed to load');
      const d = await evRes.json();
      setData({
        events: d.events || [],
        children: d.children || [],
        caregivers: d.caregivers || [],
      });
      // Overnights come from the parent-time schedule, not events; a schedule failure
      // shouldn't fail the whole report — the section just won't render.
      if (schRes.ok) {
        const s = await schRes.json();
        setSchedules(s.schedules || []);
        setOverrides(s.overrides || []);
      } else {
        // Clear so a failed refresh can't show stale custody counts for a new range.
        setSchedules([]);
        setOverrides([]);
      }
      if (sealRes.ok) {
        const sd = await sealRes.json();
        setSeals(sd.seals || []);
      } else {
        setSeals([]);
      }
      if (shareRes.ok) {
        setShareTokens((await shareRes.json()).tokens || []);
      } else {
        setShareTokens([]);
      }
      setGeneratedAt(new Date().toLocaleString('en-US'));
    } catch {
      setError('Could not load the report data.');
    } finally {
      setLoading(false);
    }
  }, [from, to, goToLogin]);

  useEffect(() => {
    load();
  }, [load]);

  const childName = (id) => data.children.find((c) => c.id === id)?.name || '?';
  const cgName = (id) =>
    id ? data.caregivers.find((c) => c.id === id)?.name || 'Unknown' : 'Unassigned';
  // A split two-leg trip credits two parents; show both with their leg, else the single parent.
  const doneBy = (e) =>
    isTrip(e.type) && e.pd === 'both' && e.pickup_caregiver_id
      ? `${cgName(e.caregiver_id)} (drop-off) / ${cgName(e.pickup_caregiver_id)} (pickup)`
      : cgName(e.caregiver_id);

  const filtered = useMemo(
    () => data.events.filter((e) => !childId || e.child_id === childId),
    [data.events, childId]
  );

  const report = useMemo(
    () => summarizeInvolvement(filtered, data.caregivers),
    [filtered, data.caregivers]
  );

  const detail = useMemo(
    () => [...filtered].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    [filtered]
  );

  // Overnights are family-level (the custody schedule covers both kids), so this is
  // computed from the schedule + overrides over the range, independent of the child filter.
  const overnights = useMemo(
    () => overnightCounts(from, to, schedules, overrides),
    [from, to, schedules, overrides]
  );
  const overnightRows = useMemo(() => {
    const rows = data.caregivers
      .filter((c) => overnights.counts[c.id])
      .map((c) => ({ id: c.id, name: c.name, n: overnights.counts[c.id] }));
    if (overnights.unassigned)
      rows.push({ id: UNASSIGNED, name: 'Unassigned', n: overnights.unassigned });
    return rows.map((r) => ({
      ...r,
      pct: overnights.total ? Math.round((r.n / overnights.total) * 100) : 0,
    }));
  }, [data.caregivers, overnights]);

  function exportCsv() {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [];
    lines.push('Parental involvement report');
    lines.push(`Generated,${esc(generatedAt)}`);
    lines.push(`Range,${esc(from)} to ${esc(to)}`);
    lines.push(`Child,${esc(childId ? childName(childId) : 'All children')}`);
    lines.push(
      'Note,A shared trip (drop-off by one parent, pickup by the other) credits each parent once, so parent totals count trips/care performed and can exceed the number of logged events.'
    );
    lines.push('');
    lines.push(
      ['Parent', ...report.typeKeys.map((t) => TYPES[t]?.label || t), 'Total', '% of all']
        .map(esc)
        .join(',')
    );
    for (const key of report.order) {
      const b = report.buckets[key];
      const pct = report.grand ? Math.round((b.total / report.grand) * 100) : 0;
      lines.push(
        [
          key === UNASSIGNED ? 'Unassigned' : cgName(key),
          ...report.typeKeys.map((t) => b.byType[t] || 0),
          b.total,
          `${pct}%`,
        ]
          .map(esc)
          .join(',')
      );
    }
    lines.push('');
    lines.push('Detailed log');
    lines.push(
      ['Date', 'Time', 'Activity', 'Child', 'Done by', 'Recorded (local)', 'Note'].map(esc).join(',')
    );
    for (const e of detail) {
      lines.push(
        [
          e.date,
          e.time,
          TYPES[e.type]?.label || e.type,
          childName(e.child_id),
          doneBy(e),
          e.updated_at ? `${fmtRecorded(e.created_at)} (edited ${fmtRecorded(e.updated_at)})` : fmtRecorded(e.created_at),
          e.who || '',
        ]
          .map(esc)
          .join(',')
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `involvement-${from}_to_${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function loadSeals() {
    try {
      const res = await fetch('/api/seals', { cache: 'no-store' });
      if (res.ok) setSeals((await res.json()).seals || []);
    } catch {
      /* leave the list as-is on a transient error */
    }
  }

  async function doVerify() {
    if (!monthSel) return;
    try {
      const res = await fetch(`/api/seals/verify?month=${monthSel}`, { cache: 'no-store' });
      if (res.status === 401) {
        await goToLogin();
        return;
      }
      setSealStatus(await res.json().catch(() => ({ error: 'Verify failed' })));
    } catch {
      setSealStatus({ error: 'Network error' });
    }
  }

  async function doSeal() {
    if (!monthSel) return;
    setSealBusy(true);
    try {
      const res = await fetch('/api/seals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: monthSel }),
      });
      if (res.status === 401) {
        await goToLogin();
        return;
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setSealStatus({ error: d.error || 'Seal failed' });
        return;
      }
      await loadSeals();
      await doVerify();
    } catch {
      setSealStatus({ error: 'Network error' });
    } finally {
      setSealBusy(false);
    }
  }

  async function loadShare() {
    try {
      const res = await fetch('/api/share', { cache: 'no-store' });
      if (res.ok) setShareTokens((await res.json()).tokens || []);
    } catch {
      /* leave the list as-is */
    }
  }

  async function createShare() {
    setShareBusy(true);
    setShareUrl('');
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: shareLabel, date_from: from, date_to: to, days: shareDays }),
      });
      if (res.status === 401) {
        await goToLogin();
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(d.error || 'Could not create link');
        return;
      }
      // Build the link from THIS browser's origin — the server can't (behind the proxy its
      // request origin is the container's internal 0.0.0.0:3000 bind). shown once.
      setShareUrl(`${window.location.origin}/share/${d.token}`);
      setShareLabel('');
      await loadShare();
    } catch {
      alert('Network error');
    } finally {
      setShareBusy(false);
    }
  }

  async function revokeShare(id) {
    try {
      const res = await fetch(`/api/share/${id}`, { method: 'DELETE' });
      if (res.status === 401) {
        await goToLogin();
        return;
      }
      await loadShare();
    } catch {
      alert('Network error');
    }
  }

  return (
    <div className="report">
      <div className="report-controls no-print">
        <a className="btn" href="/">‹ Calendar</a>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Child
          <select value={childId} onChange={(e) => setChildId(e.target.value)}>
            <option value="">All children</option>
            {data.children.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <button className="btn" onClick={load}>Refresh</button>
        <button className="btn" onClick={exportCsv}>⬇ CSV</button>
        <button className="btn" onClick={() => window.print()}>⎙ Print / PDF</button>
      </div>

      <header className="report-head">
        <h1>Parental Involvement Report</h1>
        <p className="report-meta">
          {childId ? childName(childId) : 'All children'} · {fmtDate(from)} – {fmtDate(to)}
          {generatedAt ? ` · generated ${generatedAt}` : ''}
        </p>
        <p className="report-note">
          Self-reported log. Each entry shows when it was recorded (local time); entries
          changed after creation are marked “edited.” This summary reflects only what has
          been logged in the app.
        </p>
      </header>

      {!loading && !error && overnights.total - overnights.unassigned > 0 && (
        <>
          <h2 className="report-h2">Overnights — {overnights.total} nights</h2>
          <p className="report-note">
            Nights with the kids per parent over {fmtDate(from)} – {fmtDate(to)}, from the
            parent-time schedule and any overrides (independent of the child filter).
          </p>
          <div className="table-scroll">
          <table className="report-table">
            <thead>
              <tr>
                <th>Parent</th>
                <th>Overnights</th>
                <th>% of nights</th>
              </tr>
            </thead>
            <tbody>
              {overnightRows.map((r) => (
                <tr key={r.id}>
                  <td className="rowlab">{r.name}</td>
                  <td className="tot">{r.n}</td>
                  <td className="tot">{r.pct}%</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="rowlab">All</td>
                <td className="tot">{overnights.total}</td>
                <td className="tot">100%</td>
              </tr>
            </tfoot>
          </table>
          </div>
        </>
      )}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : error ? (
        <div className="loading">
          {error} <button className="btn" onClick={load}>Retry</button>
        </div>
      ) : report.grand === 0 ? (
        <div className="loading">No entries in this date range.</div>
      ) : (
        <>
          <h2 className="report-h2">Summary — {report.grand} entries</h2>
          <p className="report-note">
            A shared trip (drop-off by one parent, pickup by the other) credits each parent once, so
            these counts reflect trips/care performed and can exceed the number of logged events below.
          </p>
          <div className="table-scroll">
          <table className="report-table">
            <thead>
              <tr>
                <th>Parent</th>
                {report.typeKeys.map((t) => (
                  <th key={t}>{TYPES[t]?.label || t}</th>
                ))}
                <th>Total</th>
                <th>% of all</th>
              </tr>
            </thead>
            <tbody>
              {report.order.map((key) => {
                const b = report.buckets[key];
                const pct = report.grand ? Math.round((b.total / report.grand) * 100) : 0;
                return (
                  <tr key={key}>
                    <td className="rowlab">{key === UNASSIGNED ? 'Unassigned' : cgName(key)}</td>
                    {report.typeKeys.map((t) => (
                      <td key={t}>{b.byType[t] || 0}</td>
                    ))}
                    <td className="tot">{b.total}</td>
                    <td className="tot">{pct}%</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="rowlab">All</td>
                {report.typeKeys.map((t) => (
                  <td key={t}>
                    {report.order.reduce((s, key) => s + (report.buckets[key].byType[t] || 0), 0)}
                  </td>
                ))}
                <td className="tot">{report.grand}</td>
                <td className="tot">100%</td>
              </tr>
            </tfoot>
          </table>
          </div>

          <h2 className="report-h2">Detailed log — {detail.length} events</h2>
          <div className="table-scroll">
          <table className="report-table detail">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Activity</th>
                <th>Child</th>
                <th>Done by</th>
                <th>Recorded (local)</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {detail.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDate(e.date)}</td>
                  <td>{fmtTime(e.time)}</td>
                  <td>
                    {TYPES[e.type]?.label || e.type}
                    {TYPES[e.type]?.trip ? ` (${PD[e.pd] || ''})` : ''}
                  </td>
                  <td>{childName(e.child_id)}</td>
                  <td>{doneBy(e)}</td>
                  <td className="muted">
                    {fmtRecorded(e.created_at)}
                    {e.updated_at ? (
                      <span className="edited"> · edited {fmtRecorded(e.updated_at)}</span>
                    ) : null}
                  </td>
                  <td>{e.who || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      {!loading && !error && (
        <>
          <h2 className="report-h2">Record seals</h2>
          <p className="report-note">
            Seal a month to lock in a tamper-evident SHA-256 + HMAC over its events and overnight
            split. Re-sealing keeps prior seals as history; Verify recomputes and reports whether the
            month still matches its latest seal.
          </p>
          <div className="report-controls no-print">
            <label>
              Month
              <input
                type="month"
                value={monthSel}
                onChange={(e) => {
                  setMonthSel(e.target.value);
                  setSealStatus(null);
                }}
              />
            </label>
            <button className="btn" onClick={doSeal} disabled={sealBusy || !monthSel}>
              {sealBusy ? 'Sealing…' : '🔒 Seal month'}
            </button>
            <button className="btn" onClick={doVerify} disabled={!monthSel}>
              Verify
            </button>
          </div>
          {sealStatus && (
            <p
              className={`seal-status ${
                sealStatus.error || (sealStatus.sealed && !sealStatus.match)
                  ? 'tamper'
                  : sealStatus.sealed
                  ? 'ok'
                  : ''
              }`}
            >
              {sealStatus.error
                ? sealStatus.error
                : sealStatus.sealed === false
                ? `No seal yet for ${monthSel}.`
                : sealStatus.match
                ? `✓ ${monthSel} matches its seal (${sealStatus.event_count_now} entries), sealed ${fmtRecorded(
                    sealStatus.sealed_at
                  )}.`
                : `⚠ ${monthSel} has changed since its last seal (${sealStatus.event_count_sealed} entries sealed, ${sealStatus.event_count_now} now).`}
            </p>
          )}
          {seals.length > 0 && (
            <div className="table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Sealed</th>
                  <th>Entries</th>
                  <th>Digest (SHA-256)</th>
                </tr>
              </thead>
              <tbody>
                {seals.map((s) => (
                  <tr key={s.id}>
                    <td className="rowlab">{s.month}</td>
                    <td>{fmtRecorded(s.sealed_at)}</td>
                    <td className="tot">{s.event_count}</td>
                    <td className="muted seal-digest">{s.sha256.slice(0, 16)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </>
      )}

      {!loading && !error && (
        <>
          <h2 className="report-h2">Share with a lawyer</h2>
          <p className="report-note">
            Create an expiring, read-only link to the full report (all children) for the range above
            ({fmtDate(from)} – {fmtDate(to)}) — independent of the child filter. Anyone with the link
            sees it without logging in — no edits, no other data. Revoke a link anytime.
          </p>
          <div className="report-controls no-print">
            <label>
              Label
              <input
                type="text"
                value={shareLabel}
                placeholder="e.g. Smith Law"
                onChange={(e) => setShareLabel(e.target.value)}
              />
            </label>
            <label>
              Expires
              <select value={shareDays} onChange={(e) => setShareDays(Number(e.target.value))}>
                <option value={7}>in 7 days</option>
                <option value={30}>in 30 days</option>
                <option value={90}>in 90 days</option>
              </select>
            </label>
            <button className="btn" onClick={createShare} disabled={shareBusy}>
              {shareBusy ? 'Creating…' : '🔗 Create link'}
            </button>
          </div>
          {shareUrl && (
            <p className="seal-status ok">
              Link created — copy it now, it won’t be shown again:
              <input
                className="share-url"
                readOnly
                aria-label="Share link URL"
                value={shareUrl}
                onFocus={(e) => e.target.select()}
              />
            </p>
          )}
          {shareTokens.length > 0 && (
            <div className="table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Range</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shareTokens.map((t) => (
                  <tr key={t.id}>
                    <td className="rowlab">{t.label || '—'}</td>
                    <td>
                      {fmtDate(t.date_from)} – {fmtDate(t.date_to)}
                    </td>
                    <td>{fmtRecorded(t.expires_at)}</td>
                    <td>{t.revoked ? 'Revoked' : t.active ? 'Active' : 'Expired'}</td>
                    <td>
                      {!t.revoked && (
                        <button className="btn btn-del" onClick={() => revokeShare(t.id)}>
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
        </>
      )}
    </div>
  );
}

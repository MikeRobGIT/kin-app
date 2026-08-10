export const dynamic = 'force-dynamic';
import db from '@/lib/db';
import { authSecret } from '@/lib/auth';
import { resolveShareToken } from '@/lib/share-writes';
import { summarizeInvolvement, UNASSIGNED } from '@/lib/report';
import { overnightCounts } from '@/lib/schedule';
import { TYPES, PD, isTrip } from '@/lib/constants';
import { fmtRecorded } from '@/lib/format';

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'a' : 'p';
  h = h % 12 || 12;
  return `${h}:${pad(m)}${ap}`;
}

function Invalid() {
  return (
    <div className="report">
      <div className="share-invalid">
        This share link is invalid, expired, or has been revoked.
      </div>
    </div>
  );
}

// Public, login-less, read-only. The capability token (resolved server-side) is the ONLY thing
// that grants access, and it grants exactly the involvement report for its baked-in date range —
// no mutations, no other data, no other routes.
export default async function SharePage({ params }) {
  const { token } = await params;
  let row;
  try {
    row = resolveShareToken(token, authSecret());
  } catch {
    row = null; // missing AUTH_SECRET, bad token, etc. — never leak why
  }
  if (!row) return <Invalid />;

  const { date_from, date_to } = row;
  const events = db
    .prepare('SELECT * FROM events WHERE date >= ? AND date <= ? ORDER BY date, time')
    .all(date_from, date_to);
  const children = db.prepare('SELECT * FROM children ORDER BY sort').all();
  const caregivers = db.prepare('SELECT * FROM caregivers ORDER BY sort').all();
  const schedules = db.prepare('SELECT * FROM schedules').all();
  const overrides = db.prepare('SELECT * FROM schedule_overrides').all();

  const childName = (id) => children.find((c) => c.id === id)?.name || '?';
  const cgName = (id) => (id ? caregivers.find((c) => c.id === id)?.name || 'Unknown' : 'Unassigned');
  // A split two-leg trip credits two parents; show both with their leg, else the single parent.
  const doneBy = (e) =>
    isTrip(e.type) && e.pd === 'both' && e.pickup_caregiver_id
      ? `${cgName(e.caregiver_id)} (drop-off) / ${cgName(e.pickup_caregiver_id)} (pickup)`
      : cgName(e.caregiver_id);

  const summary = summarizeInvolvement(events, caregivers);
  const detail = [...events].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const overnights = overnightCounts(date_from, date_to, schedules, overrides);
  const onRows = caregivers
    .filter((c) => overnights.counts[c.id])
    .map((c) => ({ id: c.id, name: c.name, n: overnights.counts[c.id] }));
  if (overnights.unassigned) onRows.push({ id: UNASSIGNED, name: 'Unassigned', n: overnights.unassigned });
  const onPct = (n) => (overnights.total ? Math.round((n / overnights.total) * 100) : 0);
  const showOvernights = overnights.total - overnights.unassigned > 0;

  return (
    <div className="report">
      <header className="report-head">
        <h1>Parental Involvement Report</h1>
        <p className="report-meta">
          Shared read-only · {fmtDate(date_from)} – {fmtDate(date_to)}
        </p>
        <p className="report-note">
          Read-only shared view of self-reported care/transport entries and the parent-time
          schedule for this period. Each entry shows when it was recorded (local time); entries
          changed after creation are marked “edited.”
        </p>
      </header>

      {showOvernights && (
        <>
          <h2 className="report-h2">Overnights — {overnights.total} nights</h2>
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
              {onRows.map((r) => (
                <tr key={r.id}>
                  <td className="rowlab">{r.name}</td>
                  <td className="tot">{r.n}</td>
                  <td className="tot">{onPct(r.n)}%</td>
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

      {summary.grand === 0 ? (
        <div className="loading">No entries in this date range.</div>
      ) : (
        <>
          <h2 className="report-h2">Summary — {summary.grand} entries</h2>
          <p className="report-note">
            A shared trip (drop-off by one parent, pickup by the other) credits each parent once, so
            these counts reflect trips/care performed and can exceed the number of logged events below.
          </p>
          <div className="table-scroll">
          <table className="report-table">
            <thead>
              <tr>
                <th>Parent</th>
                {summary.typeKeys.map((t) => (
                  <th key={t}>{TYPES[t]?.label || t}</th>
                ))}
                <th>Total</th>
                <th>% of all</th>
              </tr>
            </thead>
            <tbody>
              {summary.order.map((key) => {
                const b = summary.buckets[key];
                const pct = summary.grand ? Math.round((b.total / summary.grand) * 100) : 0;
                return (
                  <tr key={key}>
                    <td className="rowlab">{key === UNASSIGNED ? 'Unassigned' : cgName(key)}</td>
                    {summary.typeKeys.map((t) => (
                      <td key={t}>{b.byType[t] || 0}</td>
                    ))}
                    <td className="tot">{b.total}</td>
                    <td className="tot">{pct}%</td>
                  </tr>
                );
              })}
            </tbody>
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
                    {e.updated_at ? <span className="edited"> · edited {fmtRecorded(e.updated_at)}</span> : null}
                  </td>
                  <td>{e.who || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </div>
  );
}

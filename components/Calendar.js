'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { TYPES, PD, isTrip } from '@/lib/constants';
import { parentOnDate, softColor, initials, ymdLocal as ymd } from '@/lib/schedule';
import { defaultEventTime } from '@/lib/format';
import { expandRecurrence } from '@/lib/recurrence';
import { validateRecurrence, REPEAT } from '@/lib/validate';
import { trapTab } from '@/lib/trap-tab';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WD_TOKENS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']; // repeat picker order (Mon-first)
const HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

const pad = (n) => String(n).padStart(2, '0'); // still needed for HH:MM formatting
function fmtTime(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'a' : 'p';
  h = h % 12 || 12;
  return `${h}:${pad(m)}${ap}`;
}
function startOfWeek(d) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Backfill helpers: format the server's YYYY-MM-DD strings for the preview, in local time.
const WD_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const fmtDayLabel = (s) =>
  parseYmd(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const fmtRange = (s) => parseYmd(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
// Bucket an event into the visible grid. Events before 6am or after 8pm clamp
// into the first/last visible row instead of vanishing from week/day views.
const clampHour = (t) => Math.min(20, Math.max(6, parseInt(t, 10)));

// Props for a div that behaves like a button for keyboard users too.
const clickable = (fn, label) => ({
  role: 'button',
  tabIndex: 0,
  'aria-label': label,
  onKeyDown: (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }
  },
});

const EMPTY = {
  title: '',
  type: 'school',
  // '' (not a hardcoded seed id) — openModal fills the first ACTIVE child; a spread that omits
  // child_id then stays blank (forcing a pick) instead of resurrecting a possibly-archived 'c1'.
  child_id: '',
  caregiver_id: '',
  pickup_caregiver_id: '',
  pd: 'dropoff',
  date: '',
  time: '08:00',
  who: '',
  notes: '',
};

// Add-modal "Repeat" defaults: no weekdays = one-off. weekdays present = recurring.
const EMPTY_REPEAT = { weekdays: [], interval: 1, endType: 'until', until: '', count: 10 };

// Sentence-case radio labels for the Trip control (.seg uppercases them in CSS). Keep every label a
// SINGLE word — a `flex:1` segment breaks a two-word label at the space and grows the row.
const PD_LABEL = { dropoff: 'Drop-off', pickup: 'Pickup', both: 'Both', none: 'None' };

// The caregiver line on a chip. A split two-leg trip (pd='both' with a distinct pickup parent)
// tags each parent with its DROP / PICK direction; every other event shows the single "Done by"
// parent exactly as before. Shared by the calendar Chip and the agenda list so they never diverge.
function CaregiverMeta({ ev, caregiverMap }) {
  const cg = caregiverMap?.[ev.caregiver_id];
  if (isTrip(ev.type) && ev.pd === 'both' && ev.pickup_caregiver_id) {
    const pickCg = caregiverMap?.[ev.pickup_caregiver_id];
    return (
      <>
        <span className="pd">{PD.dropoff}</span>
        {cg ? ` ${cg.name} ` : ' '}
        <span className="pd">{PD.pickup}</span>
        {pickCg ? ` ${pickCg.name}` : ''}
      </>
    );
  }
  return (
    <>
      {isTrip(ev.type) && <span className="pd">{PD[ev.pd]}</span>}
      {cg ? ` · ${cg.name}` : ''}
    </>
  );
}

function Chip({ ev, childMap, caregiverMap, onEdit }) {
  const t = TYPES[ev.type] || TYPES.other;
  const ch = childMap[ev.child_id];
  return (
    <div
      className="chip"
      style={{ background: t.soft, borderLeftColor: t.c }}
      {...clickable(() => onEdit(ev), `Edit ${ev.title}`)}
      onClick={(e) => {
        e.stopPropagation();
        onEdit(ev);
      }}
    >
      <div className="t">{fmtTime(ev.time)}</div>
      <div className="ttl">{ev.title}</div>
      <div className="meta">
        <span className="dot" style={{ background: ch?.color || '#999' }} />
        {ch?.name || '?'}
        <CaregiverMeta ev={ev} caregiverMap={caregiverMap} />
        {ev.who ? ` · ${ev.who}` : ''}
      </div>
    </div>
  );
}

function FragmentRow({ hr, days, events, childMap, caregiverMap, onEdit, onAdd }) {
  return (
    <>
      <div className="timecell">{fmtTime(pad(hr) + ':00')}</div>
      {days.map((d, i) => {
        const ds = ymd(d);
        const evs = events
          .filter((e) => e.date === ds && clampHour(e.time) === hr)
          .sort((a, b) => a.time.localeCompare(b.time));
        return (
          <div
            key={i}
            className="slot"
            onClick={() => onAdd({ date: ds, hour: hr })}
          >
            {evs.map((ev) => (
              <Chip key={ev.id} ev={ev} childMap={childMap} caregiverMap={caregiverMap} onEdit={onEdit} />
            ))}
          </div>
        );
      })}
    </>
  );
}

function WeekView({ cursor, todayStr, events, childMap, caregiverMap, onEdit, onAdd, parentForDate, showParentTime }) {
  const s = startOfWeek(cursor);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(s);
    d.setDate(d.getDate() + i);
    return d;
  });

  // Phone (stacked) mode only: bring today's section into view on mount so a
  // mid-week today isn't buried below Mon–Wed. matchMedia in an effect is
  // client-only (same guard as the pointer:coarse idle timer), so SSR is safe.
  const stackRef = useRef(null);
  useEffect(() => {
    if (!window.matchMedia('(max-width: 640px)').matches) return;
    const el = stackRef.current?.querySelector('.wk-day.today');
    // 'nearest' only scrolls when today is actually below the fold — an early-week
    // today needs no scroll, so the page header/tabs/nav aren't pushed off-screen.
    if (el && el !== stackRef.current.firstElementChild) el.scrollIntoView({ block: 'nearest' });
  }, []);

  return (
    <>
      <div className="week-grid">
        <div className="corner" />
        {days.map((d, i) => (
          <div key={i} className={`dayhead ${ymd(d) === todayStr ? 'today' : ''}`}>
            {DAYS[i]}
            <span className="dnum">{d.getDate()}</span>
          </div>
        ))}
        {showParentTime && (
          <>
            <div className="pt-rail" />
            {days.map((d, i) => {
              const p = parentForDate(ymd(d));
              const prev = i > 0 ? parentForDate(ymd(days[i - 1])) : null;
              const handoff = p && prev && p.id !== prev.id;
              return (
                <div
                  key={`pt-${i}`}
                  className={`parent-band${handoff ? ' handoff' : ''}`}
                  style={p ? { background: softColor(p.color) } : undefined}
                  title={p ? `${p.name} has the kids` : ''}
                >
                  {p ? p.name : ''}
                  {handoff ? ' ⇄' : ''}
                </div>
              );
            })}
          </>
        )}
        {HOURS.map((hr) => (
          <FragmentRow
            key={hr}
            hr={hr}
            days={days}
            events={events}
            childMap={childMap}
            caregiverMap={caregiverMap}
            onEdit={onEdit}
            onAdd={onAdd}
          />
        ))}
      </div>

      {/* Phones (≤640px): the same week as 7 stacked day sections; CSS shows one of the two.
          Reuses the day-view row idiom (.day-row/.hr/.ev + Chip + .add-inline). */}
      <div className="week-stack" ref={stackRef}>
        {days.map((d, i) => {
          const ds = ymd(d);
          const p = showParentTime ? parentForDate(ds) : null;
          const prev = i > 0 && showParentTime ? parentForDate(ymd(days[i - 1])) : null;
          const handoff = p && prev && p.id !== prev.id;
          const evs = events
            .filter((e) => e.date === ds)
            .sort((a, b) => a.time.localeCompare(b.time));
          return (
            <section key={ds} className={`wk-day ${ds === todayStr ? 'today' : ''}`}>
              <div className="wk-day-head">
                {DAYS[i]} <span className="dnum">{d.getDate()}</span>
              </div>
              {p && (
                <div
                  className="day-parent-banner"
                  style={{ background: softColor(p.color), borderColor: p.color }}
                >
                  {p.name} has the kids{handoff ? ' ⇄' : ''}
                </div>
              )}
              {evs.map((ev) => (
                <div key={ev.id} className="day-row">
                  <div className="hr">{fmtTime(ev.time)}</div>
                  <div className="ev">
                    <Chip ev={ev} childMap={childMap} caregiverMap={caregiverMap} onEdit={onEdit} />
                  </div>
                </div>
              ))}
              <div className="day-row empty">
                <div className="hr" />
                <div className="ev">
                  <span
                    className="add-inline"
                    {...clickable(() => onAdd({ date: ds }), `Add event on ${DAYS[i]} ${d.getDate()}`)}
                    onClick={() => onAdd({ date: ds })}
                  >
                    + add
                  </span>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function DayView({ cursor, events, childMap, caregiverMap, onEdit, onAdd, parentForDate, showParentTime, overrides }) {
  const ds = ymd(cursor);
  const p = showParentTime ? parentForDate(ds) : null;
  // Match parentOnDate's precedence (latest created_at wins) so the banner label
  // names the override that actually determined the parent, not just the first one.
  const ov = p
    ? overrides
        .filter((o) => ds >= o.date_from && ds <= o.date_to)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
    : null;
  return (
    <div className="day-list">
      {p && (
        <div
          className="day-parent-banner"
          style={{ background: softColor(p.color), borderColor: p.color }}
        >
          {p.name} has the kids{ov && ov.label ? ` · ${ov.label}` : ''}
        </div>
      )}
      {HOURS.map((hr) => {
        const evs = events
          .filter((e) => e.date === ds && clampHour(e.time) === hr)
          .sort((a, b) => a.time.localeCompare(b.time));
        return (
          <div key={hr} className={`day-row ${evs.length ? '' : 'empty'}`}>
            <div className="hr">{fmtTime(pad(hr) + ':00')}</div>
            <div className="ev">
              {evs.map((ev) => (
                <Chip key={ev.id} ev={ev} childMap={childMap} caregiverMap={caregiverMap} onEdit={onEdit} />
              ))}
              <span
                className="add-inline"
                {...clickable(
                  () => onAdd({ date: ds, hour: hr }),
                  `Add event at ${fmtTime(pad(hr) + ':00')}`
                )}
                onClick={() => onAdd({ date: ds, hour: hr })}
              >
                + add
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MonthView({ cursor, todayStr, events, childMap, onEdit, onAdd, onDrillDay, parentForDate, showParentTime }) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    return d;
  });
  return (
    <div className="month-grid">
      {DAYS.map((d) => (
        <div key={d} className="mh">{d}</div>
      ))}
      {cells.map((d, i) => {
        const ds = ymd(d);
        const dim = d.getMonth() !== cursor.getMonth();
        const evs = events
          .filter((e) => e.date === ds)
          .sort((a, b) => a.time.localeCompare(b.time));
        const p = showParentTime && !dim ? parentForDate(ds) : null;
        return (
          <div
            key={i}
            className={`mcell ${dim ? 'dim' : ''} ${ds === todayStr ? 'today' : ''}`}
            style={p ? { background: softColor(p.color) } : undefined}
            // Phones: cells are too small for a nested edit target, so the whole
            // cell drills to the (touch-friendly) day view. Desktop/kiosk keep
            // tap-to-add. matchMedia at tap time = client-only, no SSR surface.
            onClick={() =>
              window.matchMedia('(max-width: 640px)').matches ? onDrillDay(d) : onAdd({ date: ds })
            }
          >
            <span className="dn">{d.getDate()}</span>
            {p && (
              <span
                className="mcell-parent-badge"
                style={{ borderColor: p.color, color: p.color }}
                title={`${p.name} has the kids`}
              >
                {initials(p.name)}
              </span>
            )}
            {evs.slice(0, 3).map((ev) => {
              const t = TYPES[ev.type] || TYPES.other;
              const ch = childMap[ev.child_id];
              return (
                <div
                  key={ev.id}
                  className="mini"
                  style={{ background: t.soft, borderLeftColor: ch?.color || '#999' }}
                  {...clickable(() => onEdit(ev), `Edit ${ev.title}`)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(ev);
                  }}
                >
                  {fmtTime(ev.time)} {ev.title}
                </div>
              );
            })}
            {/* Phones: the .mini text chips (hidden via CSS ≤640px) become child-colored
                dots — a 53px cell can't show a legible title. The cell tap drills to day view. */}
            {evs.length > 0 && (
              <div className="mini-dots" aria-hidden="true">
                {evs.slice(0, 3).map((ev) => (
                  <span
                    key={ev.id}
                    className="mini-dot"
                    style={{ background: childMap[ev.child_id]?.color || '#999' }}
                  />
                ))}
              </div>
            )}
            {evs.length > 3 && (
              <div
                className="more"
                {...clickable(
                  () => onDrillDay(d),
                  `Show all ${evs.length} events on ${ds}`
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onDrillDay(d);
                }}
              >
                +{evs.length - 3} more
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Calendar() {
  const router = useRouter();
  const [events, setEvents] = useState([]);
  const [children, setChildren] = useState([]);
  const [caregivers, setCaregivers] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [showParentTime, setShowParentTime] = useState(true);
  const [view, setView] = useState('week');
  const [cursor, setCursor] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [modal, setModal] = useState(null); // {form, editingId, error, deleting, refocusDel} or null
  const triggerRef = useRef(null); // element to restore focus to when the modal closes
  const lastDefaults = useRef({ child_id: null, caregiver_id: null }); // sticky add defaults
  const [qa, setQa] = useState('');
  const [qaBusy, setQaBusy] = useState(false);
  const [backfill, setBackfill] = useState(null); // {base, dates:[{date,on}], weekdays, from, to, truncated, busy}
  const [agendaOpen, setAgendaOpen] = useState(false); // read-only today+tomorrow agenda

  const childMap = useMemo(() => {
    const m = {};
    children.forEach((c) => (m[c.id] = c));
    return m;
  }, [children]);

  const caregiverMap = useMemo(() => {
    const m = {};
    caregivers.forEach((c) => (m[c.id] = c));
    return m;
  }, [caregivers]);

  // Maps above stay FULL (so an event referencing an archived member still renders its name/color).
  // The add/edit pickers list only ACTIVE members, plus the form's current value if it happens to
  // be archived — so editing an old event doesn't render an invalid <select> or drop the value
  // (kin.md restore-selection rule).
  const activeChildren = useMemo(() => children.filter((c) => !c.archived), [children]);
  const activeCaregivers = useMemo(() => caregivers.filter((c) => !c.archived), [caregivers]);
  const withCurrent = (list, map, currentId) => {
    if (!currentId || list.some((c) => c.id === currentId)) return list;
    const c = map[currentId];
    return c ? [...list, { ...c, name: `${c.name} (archived)` }] : list;
  };
  const childOptions = (currentId) => withCurrent(activeChildren, childMap, currentId);
  const cgOptions = (currentId) => withCurrent(activeCaregivers, caregiverMap, currentId);

  // Which parent (caregiver object) has the kids on a given YYYY-MM-DD, or null.
  const parentForDate = useCallback(
    (ds) => {
      const id = parentOnDate(ds, schedules, overrides);
      return id ? caregiverMap[id] || null : null;
    },
    [schedules, overrides, caregiverMap]
  );

  const todayStr = ymd(new Date());

  // Session ended/expired: clear the stale cookie, then send to login. Clearing
  // first prevents the presence-only page gate from bouncing us back.
  const goToLogin = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* best effort */
    }
    router.replace('/login');
  }, [router]);

  const load = useCallback(async (background = false) => {
    try {
      const [evRes, schRes] = await Promise.all([
        fetch('/api/events', { cache: 'no-store' }),
        fetch('/api/schedules', { cache: 'no-store' }),
      ]);
      if (evRes.status === 401 || schRes.status === 401) {
        await goToLogin();
        return;
      }
      if (!evRes.ok) throw new Error('Failed to load events');
      const data = await evRes.json();
      setEvents(data.events || []);
      setChildren(data.children || []);
      setCaregivers(data.caregivers || []);
      if (schRes.ok) {
        const s = await schRes.json();
        setSchedules(s.schedules || []);
        setOverrides(s.overrides || []);
      }
      setLoadError(false);
    } catch {
      // A failed background refresh keeps the last-good data on screen; only
      // the initial/manual load may swap the UI for the error screen.
      if (!background) setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [goToLogin]);

  useEffect(() => {
    load();
  }, [load]);

  // Unattended kiosk: auto-retry a failed initial load with backoff (2s → 30s
  // cap) so a wifi blip at boot doesn't leave the error screen up until someone
  // taps Retry. load() clears loadError on success, which cancels this loop.
  useEffect(() => {
    if (!loadError) return;
    let delay = 2000;
    let timer;
    let cancelled = false;
    const attempt = async () => {
      // Retry in background mode so a superseded or failed retry can't flip
      // loadError back on — e.g. if a manual Retry already recovered while this
      // one was in flight. Only the initial foreground load owns the error
      // screen; a background success still clears it and loads the data.
      await load(true);
      if (cancelled) return;
      delay = Math.min(delay * 2, 30000);
      timer = setTimeout(attempt, delay);
    };
    timer = setTimeout(attempt, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadError, load]);

  // Reset to the kiosk's home state: current week, today. Optionally close any
  // open overlay (idle snap-back does; midnight rollover doesn't, so a parent
  // editing at 23:59 keeps their modal).
  const snapToNow = useCallback((closeOverlays) => {
    setView('week');
    setCursor(new Date());
    if (closeOverlays) {
      setModal(null);
      setAgendaOpen(false);
      setBackfill((b) => (b && b.busy ? b : null)); // don't close mid-save
    }
  }, []);

  // Mirror overlay-open state into a ref so the idle timer can check it when it
  // fires, without re-subscribing. (The parent-time manager now lives on /settings.)
  const kioskOverlayOpen = useRef(false);
  kioskOverlayOpen.current = !!modal || !!backfill || agendaOpen;

  // Kiosk mode (24/7 wall display): keep data fresh, keep "today" true past
  // midnight, and snap back to the default view when nobody's touching it.
  useEffect(() => {
    const POLL_MS = 5 * 60 * 1000;
    const IDLE_MS = 5 * 60 * 1000;

    // Slide the session forward now, not only on the 5-min interval, so a kiosk
    // opened or resumed in the final minutes of its 30-day cookie re-mints
    // immediately (/api/auth/me → renewIfStale) instead of expiring before the
    // first poll fires.
    const pingRenew = () => {
      fetch('/api/auth/me', { cache: 'no-store' }).catch(() => {});
    };
    pingRenew();

    const poll = setInterval(() => {
      load(true);
      pingRenew();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        load(true);
        pingRenew();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    // Midnight rollover — reschedule each fire (not a fixed 24h) so DST shifts
    // can't drift it. todayStr recomputes on the render snapToNow triggers.
    let midnight;
    const scheduleMidnight = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      midnight = setTimeout(() => {
        snapToNow(false);
        load(true);
        scheduleMidnight();
      }, next - now + 1000);
    };
    scheduleMidnight();

    // Idle snap-back: touch screens only (pointer: coarse), so a laptop user's
    // view is never yanked back to today under them.
    let idle;
    let onActivity;
    if (window.matchMedia('(pointer: coarse)').matches) {
      // When the timer fires, only snap if no overlay is open — never close a
      // form out from under someone. A soft keyboard doesn't reliably emit
      // pointerdown/keydown, so an open modal (being typed into, or abandoned)
      // just keeps the timer rescheduling until it's dismissed.
      const tick = () => {
        if (kioskOverlayOpen.current) {
          idle = setTimeout(tick, IDLE_MS);
          return;
        }
        snapToNow(true);
      };
      onActivity = () => {
        clearTimeout(idle);
        idle = setTimeout(tick, IDLE_MS);
      };
      onActivity();
      window.addEventListener('pointerdown', onActivity);
      window.addEventListener('keydown', onActivity);
    }

    return () => {
      clearInterval(poll);
      clearTimeout(midnight);
      clearTimeout(idle);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      if (onActivity) {
        window.removeEventListener('pointerdown', onActivity);
        window.removeEventListener('keydown', onActivity);
      }
    };
  }, [load, snapToNow]);

  // The overlay toggle lives on /settings; read it here on mount (client-only).
  useEffect(() => {
    const v = window.localStorage.getItem('kin.showParentTime');
    if (v != null) setShowParentTime(v === '1');
  }, []);

  // Escape-to-close + focus restore, while the modal OR the backfill preview is open.
  const overlayOpen = !!modal || !!backfill || agendaOpen;
  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (e) => {
      // defaultPrevented: e.g. Escape dismissing an open native <select> picker
      // shouldn't also close the modal (IB-12).
      if (e.key === 'Escape' && !e.defaultPrevented) {
        setModal(null);
        setAgendaOpen(false);
        setBackfill((b) => (b && b.busy ? b : null)); // don't close mid-save
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Restore focus to the element that opened the overlay. Captured in the open
      // handler (below) — reading it here would be too late, since the title
      // input's autoFocus already moved focus during the commit phase.
      const t = triggerRef.current;
      if (t && typeof t.focus === 'function') t.focus();
    };
  }, [overlayOpen]);

  function shift(dir) {
    const c = new Date(cursor);
    if (view === 'week') c.setDate(c.getDate() + 7 * dir);
    else if (view === 'day') c.setDate(c.getDate() + dir);
    else c.setMonth(c.getMonth() + dir);
    setCursor(c);
  }

  const openModal = useCallback(
    (preset = {}) => {
      triggerRef.current = document.activeElement;
      setBackfill(null); // never stack the edit modal over the backfill preview
      // Use the sticky defaults only if they still exist in the current options
      // ('' is the valid "not specified" caregiver); otherwise fall back to the first.
      // Sticky defaults are used only if they're still an ACTIVE option (an archived sticky id
      // would render an invalid <select> and 400 on save); else fall back to the first active.
      // '' is the valid "not specified" caregiver.
      const form = {
        ...EMPTY,
        child_id: activeChildren.some((c) => c.id === lastDefaults.current.child_id)
          ? lastDefaults.current.child_id
          : activeChildren[0]?.id || '',
        caregiver_id:
          lastDefaults.current.caregiver_id === '' ||
          activeCaregivers.some((c) => c.id === lastDefaults.current.caregiver_id)
            ? lastDefaults.current.caregiver_id
            : activeCaregivers[0]?.id || '',
        date: preset.date || ymd(cursor),
        ...preset,
      };
      if (preset.hour != null && !preset.time) form.time = pad(preset.hour) + ':00';
      // No explicit slot → default to ~now instead of the old hardcoded 08:00.
      else if (preset.time == null && !preset.id) form.time = defaultEventTime();
      setModal({ form, editingId: preset.id || null, repeat: { ...EMPTY_REPEAT } });
    },
    [activeChildren, activeCaregivers, cursor]
  );

  const openEdit = useCallback((ev) => {
    triggerRef.current = document.activeElement;
    setBackfill(null); // never stack the edit modal over the backfill preview
    setModal({ form: { ...ev }, editingId: ev.id, applySeries: false });
  }, []);

  const drillToDay = useCallback((d) => {
    setCursor(d);
    setView('day');
  }, []);

  const openAgenda = useCallback(() => {
    triggerRef.current = document.activeElement;
    setAgendaOpen(true);
  }, []);

  // AI quick-add: parse natural language. A one-off opens the modal for review; a recurring
  // statement opens the backfill preview (a deselectable list of the expanded dates).
  async function quickAdd() {
    const text = qa.trim();
    if (!text) return;
    setQaBusy(true);
    let d = {};
    try {
      const res = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.status === 401) {
        await goToLogin();
        return;
      }
      d = await res.json().catch(() => ({}));
    } catch {
      /* fall through to manual */
    }
    triggerRef.current = document.activeElement;
    if (d.recurrence) {
      const r = d.recurrence;
      setBackfill({
        base: { ...EMPTY, ...r.base },
        dates: (r.dates || []).map((date) => ({ date, on: true })),
        weekdays: r.weekdays || [],
        from: r.from,
        to: r.to,
        truncated: !!r.truncated,
        series: true, // a recurrence is a series → editable/deletable as a unit later
        busy: false,
      });
    } else if (d.draft) {
      setModal({ form: { ...EMPTY, ...d.draft }, editingId: null, repeat: { ...EMPTY_REPEAT } });
    } else {
      // Fall back to manual entry — carry the text in as the title so nothing is lost.
      // Default to the first ACTIVE members (not the full roster's first, which may be archived).
      setModal({
        form: {
          ...EMPTY,
          child_id: activeChildren[0]?.id || '',
          caregiver_id: activeCaregivers[0]?.id || '',
          date: ymd(cursor),
          title: text,
        },
        editingId: null,
        repeat: { ...EMPTY_REPEAT },
        error: d.error || 'Add the details and save.',
      });
    }
    setQa('');
    setQaBusy(false);
  }

  // Bulk-create the selected backfill dates as normal entries (one transaction server-side).
  async function saveBackfill() {
    if (!backfill) return;
    const chosen = backfill.dates.filter((x) => x.on);
    if (!chosen.length) return;
    const rows = chosen.map((x) => ({ ...backfill.base, date: x.date }));
    setBackfill({ ...backfill, busy: true });
    let res;
    try {
      res = await fetch('/api/events/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: rows, series: !!backfill.series }),
      });
    } catch {
      alert('Network error — not saved');
      setBackfill((b) => (b ? { ...b, busy: false } : b));
      return;
    }
    if (res.ok) {
      setBackfill(null);
      load();
    } else if (res.status === 401) {
      await goToLogin();
    } else {
      const dd = await res.json().catch(() => ({}));
      alert(dd.error || 'Save failed');
      setBackfill((b) => (b ? { ...b, busy: false } : b));
    }
  }

  async function save() {
    const f = modal.form;
    if (!f.title.trim()) {
      setModal({ ...modal, error: 'Title is required' });
      return;
    }
    const editing = modal.editingId;

    // Recurring add: expand the rule and hand off to the deselectable preview, which bulk-creates
    // the occurrences as one linked series. Weekdays present == recurring.
    if (!editing && modal.repeat?.weekdays.length) {
      const rule = { ...modal.repeat, from: f.date };
      const err = validateRecurrence(rule);
      if (err) {
        setModal({ ...modal, error: err });
        return;
      }
      const { dates, truncated } = expandRecurrence({
        weekdays: rule.weekdays,
        from: f.date,
        interval: rule.interval,
        until: rule.endType === 'until' ? rule.until : null,
        count: rule.endType === 'count' ? rule.count : null,
      });
      if (!dates.length) {
        setModal({ ...modal, error: 'That repeat produces no dates' });
        return;
      }
      triggerRef.current = document.activeElement;
      setModal(null);
      setBackfill({
        base: { ...f },
        dates: dates.map((date) => ({ date, on: true })),
        weekdays: rule.weekdays,
        from: dates[0],
        to: dates[dates.length - 1],
        interval: rule.interval,
        count: rule.endType === 'count' ? rule.count : null,
        truncated,
        series: true,
        busy: false,
      });
      return;
    }

    // Series edit: apply this occurrence's shared fields to every event in the series (dates stay).
    const seriesEdit = editing && modal.applySeries && f.series_id;
    const url = seriesEdit
      ? `/api/events/series/${f.series_id}`
      : editing
        ? `/api/events/${editing}`
        : '/api/events';
    const method = editing ? 'PUT' : 'POST';
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(f),
      });
    } catch {
      alert('Network error — not saved');
      return;
    }
    if (res.ok) {
      // Remember the last *added* entry's child + caregiver as the next add's sticky
      // defaults; editing an existing event shouldn't change your add defaults.
      if (!editing) lastDefaults.current = { child_id: f.child_id, caregiver_id: f.caregiver_id };
      setModal(null);
      load();
    } else if (res.status === 401) {
      await goToLogin();
    } else {
      const d = await res.json().catch(() => ({}));
      alert(d.error || 'Save failed');
    }
  }

  // Duplicate the event being edited: reopen the modal as a fresh Add so saving POSTs a new
  // event with its own audit `create` row. Copy exactly the persisted fields (mirrors
  // event-writes normalize) — never the source id/timestamps — and reset the date to the day
  // in view. Focus the title now, before the Duplicate button unmounts on re-render.
  function duplicate() {
    const f = modal.form;
    setModal({
      form: {
        ...EMPTY,
        title: f.title, type: f.type, child_id: f.child_id, caregiver_id: f.caregiver_id,
        pickup_caregiver_id: f.pickup_caregiver_id, pd: f.pd, time: f.time, who: f.who, notes: f.notes,
        date: ymd(cursor),
      },
      editingId: null,
      repeat: { ...EMPTY_REPEAT },
    });
    document.getElementById('evt-title')?.focus();
  }

  // Delete. A one-off (or a 1-row series) fires immediately, as before; a real repeating series asks
  // for a scope first. `scope`: 'this' | 'following' | 'all'. The "apply to the whole series"
  // checkbox is Save-only and is deliberately NOT consulted here.
  async function remove(scope) {
    if (!modal.editingId) return;
    const f = modal.form;
    let url;
    if (scope === 'all') {
      url = `/api/events/series/${f.series_id}`;
    } else if (scope === 'following') {
      // Anchor on the STORED date, not modal.form.date — that one is live-bound to the date
      // input, so an unsaved edit must not move the delete boundary. If the event has dropped out
      // of `events` (e.g. deleted elsewhere and the modal is stale from a background refresh),
      // there's no safe date to anchor on — refuse rather than guessing from the unsaved form.
      const stored = events.find((e) => e.id === modal.editingId);
      if (!stored) {
        alert('This event has changed — reload and try again.');
        return;
      }
      url = `/api/events/series/${f.series_id}?from=${stored.date}`;
    } else {
      url = `/api/events/${modal.editingId}`;
    }
    let res;
    try {
      res = await fetch(url, { method: 'DELETE' });
    } catch {
      alert('Network error — not deleted');
      return;
    }
    if (res.ok) {
      setModal(null);
      load();
    } else if (res.status === 401) {
      await goToLogin();
    } else {
      const d = await res.json().catch(() => ({}));
      alert(d.error || 'Delete failed');
    }
  }

  const periodLabel = useMemo(() => {
    if (view === 'week') {
      const s = startOfWeek(cursor);
      const e = new Date(s);
      e.setDate(e.getDate() + 6);
      return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    }
    if (view === 'day')
      return cursor.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    return cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }, [view, cursor]);

  if (loadError)
    return (
      <div className="loading">
        Couldn&apos;t load your calendar.{' '}
        <button
          className="btn"
          onClick={() => {
            setLoadError(false);
            setLoading(true);
            load();
          }}
        >
          Retry
        </button>
      </div>
    );
  if (loading) return <div className="loading">Loading…</div>;

  const f = modal?.form;
  // Repeat state is initialized by every add-modal entry point; default defensively so the
  // repeat UI can never crash if a future path forgets to set it.
  const repeat = modal?.repeat || EMPTY_REPEAT;
  // How many loaded events belong to the series being edited (drives the "apply to all" notice).
  const seriesCount = f && f.series_id ? events.filter((e) => e.series_id === f.series_id).length : 0;
  // A 1-row series has no meaningful scope choice — Delete just fires, same as a one-off.
  const isSeries = seriesCount > 1;
  // Same stored-date anchor remove() uses, so the count on the button is exactly what gets deleted.
  // No fallback to f.date here (unlike remove(), this is display-only): if the edited event has
  // dropped out of `events`, delAnchor stays null and followingCount reads 0 rather than a count
  // computed from an unsaved or stale date.
  const delAnchor = modal?.editingId ? (events.find((e) => e.id === modal.editingId)?.date ?? null) : null;
  // Gated on series_id + delAnchor, NOT on isSeries — isSeries can flip false from a background
  // refresh (a sibling deleted elsewhere) while the anchor row itself is still present and would
  // still be deleted by a click, so gating on it here would show a false "(0)".
  const followingCount =
    f && f.series_id && delAnchor
      ? events.filter((e) => e.series_id === f.series_id && e.date >= delAnchor).length
      : 0;
  const bf = backfill;
  // Read-only agenda: today + tomorrow (anchored to the real date, not the cursor),
  // each with its events in time order and the parent on duty.
  const agendaDays = agendaOpen
    ? [0, 1].map((off) => {
        const d = new Date();
        d.setDate(d.getDate() + off);
        const ds = ymd(d);
        return {
          off,
          label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
          parent: parentForDate(ds),
          evs: events.filter((e) => e.date === ds).sort((a, b) => a.time.localeCompare(b.time)),
        };
      })
    : null;
  const bfChosen = bf ? bf.dates.filter((x) => x.on).length : 0;
  const bfAllOn = bf ? bf.dates.length > 0 && bf.dates.every((x) => x.on) : false;

  return (
    <>
      <header>
        <div className="titleblock">
          <h1><em>Kin</em></h1>
          <p>Family care, day to day</p>
        </div>
        <details className="legend">
          <summary className="legend-summary">Legend</summary>
          <div className="legend-items">
            {activeChildren.map((c) => (
              <span key={c.id} className="item">
                <span className="swatch" style={{ background: c.color }} />
                {c.name}
              </span>
            ))}
            {activeCaregivers.map((c) => (
              <span key={c.id} className="item">
                <span className="swatch swatch-parent" style={{ background: c.color }} />
                {c.name}
              </span>
            ))}
            {Object.entries(TYPES).map(([k, t]) => (
              <span key={k} className="item">
                <span className="swatch" style={{ background: t.c, opacity: 0.55 }} />
                {t.label}
              </span>
            ))}
          </div>
        </details>
      </header>

      <div className="controls">
        <div className="tabs">
          {['week', 'day', 'month'].map((v) => (
            <button
              key={v}
              className={view === v ? 'active' : ''}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <button className="btn btn-add" onClick={() => openModal()}>+ Add Event</button>
        <button className="btn" onClick={() => window.print()}>⎙ Print</button>
        <button className="btn" onClick={openAgenda}>📋 Next 2 days</button>
        <a className="btn" href="/report">▤ Report</a>
        <a className="btn" href="/settings">⚙ Settings</a>
        <div className="nav">
          <button aria-label="Previous period" onClick={() => shift(-1)}>‹</button>
          <button onClick={() => setCursor(new Date())}>Today</button>
          <span className="periodlabel">{periodLabel}</span>
          <button aria-label="Next period" onClick={() => shift(1)}>›</button>
        </div>
      </div>

      <div className="quickadd no-print">
        <input
          type="text"
          value={qa}
          onChange={(e) => setQa(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && quickAdd()}
          placeholder={`Quick add — e.g. “I took ${activeChildren[0]?.name ?? 'the kids'} to school today”`}
          disabled={qaBusy}
        />
        <button className="btn btn-add" onClick={quickAdd} disabled={qaBusy}>
          {qaBusy ? 'Reading…' : '✨ Quick add'}
        </button>
      </div>

      <main>
        {view === 'week' && (
          <WeekView
            cursor={cursor}
            todayStr={todayStr}
            events={events}
            childMap={childMap}
            caregiverMap={caregiverMap}
            onEdit={openEdit}
            onAdd={openModal}
            parentForDate={parentForDate}
            showParentTime={showParentTime}
          />
        )}
        {view === 'day' && (
          <DayView
            cursor={cursor}
            events={events}
            childMap={childMap}
            caregiverMap={caregiverMap}
            onEdit={openEdit}
            onAdd={openModal}
            parentForDate={parentForDate}
            showParentTime={showParentTime}
            overrides={overrides}
          />
        )}
        {view === 'month' && (
          <MonthView
            cursor={cursor}
            todayStr={todayStr}
            events={events}
            childMap={childMap}
            onEdit={openEdit}
            onAdd={openModal}
            onDrillDay={drillToDay}
            parentForDate={parentForDate}
            showParentTime={showParentTime}
          />
        )}
      </main>

      {modal && (
        <div className="overlay" onClick={(e) => e.target.classList.contains('overlay') && setModal(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onKeyDown={trapTab}
          >
            <h2 id="modal-title">{modal.editingId ? 'Edit Event' : 'Add Event'}</h2>
            <div className="field">
              <label htmlFor="evt-title">Event / Activity</label>
              <input
                id="evt-title"
                autoFocus
                value={f.title}
                onChange={(e) => setModal({ ...modal, error: '', form: { ...f, title: e.target.value } })}
                placeholder="e.g. Soccer practice, Speech therapy"
              />
              {modal.error && <div className="err">{modal.error}</div>}
            </div>
            <div className="field">
              <label htmlFor="evt-type">Type</label>
              <select
                id="evt-type"
                value={f.type}
                onChange={(e) => setModal({ ...modal, form: { ...f, type: e.target.value } })}
              >
                <optgroup label="Transport — asks about a drop-off / pickup">
                  {Object.entries(TYPES).filter(([, t]) => t.trip).map(([k, t]) => (
                    <option key={k} value={k}>{t.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Caregiving — no drop-off or pickup">
                  {Object.entries(TYPES).filter(([, t]) => !t.trip).map(([k, t]) => (
                    <option key={k} value={k}>{t.label}</option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div className="field">
              <label htmlFor="evt-child">Child</label>
              <select
                id="evt-child"
                value={f.child_id}
                onChange={(e) => setModal({ ...modal, form: { ...f, child_id: e.target.value } })}
              >
                {childOptions(f.child_id).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            {isTrip(f.type) && (
            <div className="field" role="group" aria-labelledby="trip-label">
              <label id="trip-label">Trip</label>
              <div className="seg">
                {['dropoff', 'pickup', 'both', 'none'].map((v) => (
                  <label key={v}>
                    <input
                      type="radio"
                      name="pd"
                      checked={f.pd === v}
                      onChange={() => setModal({ ...modal, form: { ...f, pd: v } })}
                    />
                    <span>{PD_LABEL[v]}</span>
                  </label>
                ))}
              </div>
            </div>
            )}
            <div className="field">
              {/* Trip 'both' splits the legs into two parent slots below; otherwise one parent
                  covers the whole entry (drop-off, pickup, a leg-less trip, or a non-trip care
                  task). Trip 'none' reads "Done by" too — the stay-home day still has a
                  responsible parent, there just wasn't a drive. */}
              <label htmlFor="evt-caregiver">
                {!isTrip(f.type) || f.pd === 'none'
                  ? 'Done by'
                  : f.pd === 'pickup'
                    ? 'Pickup by'
                    : 'Drop-off by'}
              </label>
              <select
                id="evt-caregiver"
                value={f.caregiver_id || ''}
                onChange={(e) => setModal({ ...modal, form: { ...f, caregiver_id: e.target.value } })}
              >
                <option value="">— not specified —</option>
                {cgOptions(f.caregiver_id).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            {isTrip(f.type) && f.pd === 'both' && (
              <div className="field">
                <label htmlFor="evt-caregiver-pickup">Pickup by</label>
                <select
                  id="evt-caregiver-pickup"
                  value={f.pickup_caregiver_id || ''}
                  onChange={(e) =>
                    setModal({ ...modal, form: { ...f, pickup_caregiver_id: e.target.value } })
                  }
                >
                  <option value="">— not specified —</option>
                  {cgOptions(f.pickup_caregiver_id).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="row2">
              <div className="field">
                <label htmlFor="evt-date">Date</label>
                <input
                  id="evt-date"
                  type="date"
                  value={f.date}
                  onChange={(e) => setModal({ ...modal, form: { ...f, date: e.target.value } })}
                />
              </div>
              <div className="field">
                <label htmlFor="evt-time">Time</label>
                <input
                  id="evt-time"
                  type="time"
                  value={f.time}
                  onChange={(e) => setModal({ ...modal, form: { ...f, time: e.target.value } })}
                />
              </div>
            </div>
            {!modal.editingId && (
              <div className="field repeat">
                <label id="repeat-label">Repeat on</label>
                <div className="rpt-grid" role="group" aria-labelledby="repeat-label">
                  {WD_TOKENS.map((w) => {
                    const on = repeat.weekdays.includes(w);
                    return (
                      <button
                        type="button"
                        key={w}
                        className={'rpt-day' + (on ? ' on' : '')}
                        aria-pressed={on}
                        aria-label={WD_LABEL[w]}
                        onClick={() =>
                          setModal({
                            ...modal,
                            error: '',
                            repeat: {
                              ...repeat,
                              weekdays: on
                                ? repeat.weekdays.filter((x) => x !== w)
                                : [...repeat.weekdays, w],
                            },
                          })
                        }
                      >
                        {WD_LABEL[w].slice(0, 2)}
                      </button>
                    );
                  })}
                </div>
                {repeat.weekdays.length > 0 && (
                  <div className="rpt-opts">
                    <div className="rpt-inline">
                      <span>every</span>
                      <input
                        type="number"
                        min="1"
                        max={REPEAT.maxInterval}
                        aria-label="Repeat every N weeks"
                        value={repeat.interval}
                        onChange={(e) =>
                          setModal({
                            ...modal,
                            repeat: {
                              ...repeat,
                              interval: Math.max(
                                1,
                                Math.min(REPEAT.maxInterval, parseInt(e.target.value, 10) || 1)
                              ),
                            },
                          })
                        }
                      />
                      <span>wk</span>
                    </div>
                    <div className="seg rpt-end">
                      {['until', 'count'].map((v) => (
                        <label key={v}>
                          <input
                            type="radio"
                            name="rpt-end"
                            checked={repeat.endType === v}
                            onChange={() => setModal({ ...modal, repeat: { ...repeat, endType: v } })}
                          />
                          <span>{v === 'until' ? 'Until' : 'For'}</span>
                        </label>
                      ))}
                    </div>
                    {repeat.endType === 'until' ? (
                      <input
                        type="date"
                        aria-label="Repeat until date"
                        min={f.date}
                        value={repeat.until}
                        onChange={(e) =>
                          setModal({ ...modal, repeat: { ...repeat, until: e.target.value } })
                        }
                      />
                    ) : (
                      <div className="rpt-inline">
                        <input
                          type="number"
                          min="1"
                          max={REPEAT.maxCount}
                          aria-label="Number of occurrences"
                          value={repeat.count}
                          onChange={(e) =>
                            setModal({
                              ...modal,
                              repeat: {
                                ...repeat,
                                count: Math.max(
                                  1,
                                  Math.min(REPEAT.maxCount, parseInt(e.target.value, 10) || 1)
                                ),
                              },
                            })
                          }
                        />
                        <span>times</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="field">
              <label htmlFor="evt-who">Who else / note (optional)</label>
              <input
                id="evt-who"
                value={f.who}
                onChange={(e) => setModal({ ...modal, form: { ...f, who: e.target.value } })}
                placeholder="e.g. Grandma, carpool"
              />
            </div>
            {modal.editingId && f.series_id && (
              <div className="field series-note">
                <label className="series-note-lbl">
                  <input
                    type="checkbox"
                    checked={!!modal.applySeries}
                    onChange={(e) => setModal({ ...modal, applySeries: e.target.checked })}
                  />
                  <span>
                    Apply edits to the whole repeating series
                    {seriesCount > 1 ? ` (${seriesCount} events)` : ''}
                  </span>
                </label>
              </div>
            )}
            {modal.deleting ? (
              // The question sits INSIDE .modal-actions as a full-width flex item. As a sibling it
              // was painted over: at ≤640px the bar is position:sticky with an opaque background
              // (globals.css), so it lifts off the flow and covers the heading right above it —
              // leaving four unlabelled destructive buttons on a phone. .modal-actions must stay a
              // DIRECT child of .modal, or it loses that sticky rule altogether.
              // autoFocus on Cancel: the focused Delete just unmounted, and without a replacement
              // taking focus it falls to <body> and trapTab stops engaging — but the key that fires
              // on an overlay you didn't expect shouldn't be a delete.
              <div className="modal-actions" role="group" aria-labelledby="del-scope-q">
                <div id="del-scope-q">Delete which events?</div>
                <button className="btn btn-del" onClick={() => remove('this')}>
                  This event
                </button>
                <button className="btn btn-del" onClick={() => remove('following')}>
                  This + following ({followingCount})
                </button>
                <button className="btn btn-del" onClick={() => remove('all')}>
                  All ({seriesCount})
                </button>
                <button
                  className="btn"
                  autoFocus
                  onClick={() => setModal({ ...modal, deleting: false, refocusDel: true })}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="modal-actions">
                {modal.editingId && (
                  <>
                    {/* refocusDel is set only by the strip's Cancel, so Delete re-mounts with focus;
                        undefined on a normal open, leaving the title input's autoFocus alone. */}
                    <button
                      className="btn btn-del"
                      autoFocus={!!modal.refocusDel}
                      onClick={() =>
                        isSeries ? setModal({ ...modal, deleting: true }) : remove('this')
                      }
                    >
                      Delete
                    </button>
                    <button className="btn" onClick={duplicate}>Duplicate</button>
                  </>
                )}
                <button className="btn" onClick={() => setModal(null)}>Cancel</button>
                <button className="btn btn-save" onClick={save}>Save</button>
              </div>
            )}
          </div>
        </div>
      )}

      {bf && (
        <div className="overlay" onClick={(e) => e.target.classList.contains('overlay') && !bf.busy && setBackfill(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bf-title"
            onKeyDown={trapTab}
          >
            <h2 id="bf-title">Repeating entries</h2>
            <div className="field">
              <label htmlFor="bf-title-input">Event / Activity</label>
              <input
                id="bf-title-input"
                autoFocus
                value={bf.base.title}
                onChange={(e) => setBackfill({ ...bf, base: { ...bf.base, title: e.target.value } })}
              />
            </div>
            <div className="field">
              <label htmlFor="bf-type">Type</label>
              <select
                id="bf-type"
                value={bf.base.type}
                onChange={(e) => setBackfill({ ...bf, base: { ...bf.base, type: e.target.value } })}
              >
                <optgroup label="Transport — asks about a drop-off / pickup">
                  {Object.entries(TYPES).filter(([, t]) => t.trip).map(([k, t]) => (
                    <option key={k} value={k}>{t.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Caregiving — no drop-off or pickup">
                  {Object.entries(TYPES).filter(([, t]) => !t.trip).map(([k, t]) => (
                    <option key={k} value={k}>{t.label}</option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div className="row2">
              <div className="field">
                <label htmlFor="bf-child">Child</label>
                <select
                  id="bf-child"
                  value={bf.base.child_id}
                  onChange={(e) => setBackfill({ ...bf, base: { ...bf.base, child_id: e.target.value } })}
                >
                  {childOptions(bf.base.child_id).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="bf-caregiver">
                  {!isTrip(bf.base.type) || bf.base.pd === 'none'
                    ? 'Done by'
                    : bf.base.pd === 'pickup'
                      ? 'Pickup by'
                      : 'Drop-off by'}
                </label>
                <select
                  id="bf-caregiver"
                  value={bf.base.caregiver_id || ''}
                  onChange={(e) => setBackfill({ ...bf, base: { ...bf.base, caregiver_id: e.target.value } })}
                >
                  <option value="">— not specified —</option>
                  {cgOptions(bf.base.caregiver_id).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>
            {isTrip(bf.base.type) && (
              <div className="field" role="group" aria-labelledby="bf-trip-label">
                <label id="bf-trip-label">Trip</label>
                <div className="seg">
                  {['dropoff', 'pickup', 'both', 'none'].map((v) => (
                    <label key={v}>
                      <input
                        type="radio"
                        name="bf-pd"
                        checked={bf.base.pd === v}
                        onChange={() => setBackfill({ ...bf, base: { ...bf.base, pd: v } })}
                      />
                      <span>{PD_LABEL[v]}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {isTrip(bf.base.type) && bf.base.pd === 'both' && (
              <div className="field">
                <label htmlFor="bf-caregiver-pickup">Pickup by</label>
                <select
                  id="bf-caregiver-pickup"
                  value={bf.base.pickup_caregiver_id || ''}
                  onChange={(e) =>
                    setBackfill({ ...bf, base: { ...bf.base, pickup_caregiver_id: e.target.value } })
                  }
                >
                  <option value="">— not specified —</option>
                  {cgOptions(bf.base.pickup_caregiver_id).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="bf-time">Time</label>
              <input
                id="bf-time"
                type="time"
                value={bf.base.time}
                onChange={(e) => setBackfill({ ...bf, base: { ...bf.base, time: e.target.value } })}
              />
            </div>

            <div className="bf-summary">
              {bf.weekdays.map((w) => WD_LABEL[w] || w).join(', ')}
              {bf.interval > 1 && ` · every ${bf.interval} wks`} · {fmtRange(bf.from)} – {fmtRange(bf.to)}
              {bf.truncated && <span className="bf-trunc"> · showing first {bf.dates.length}</span>}
            </div>
            <div className="bf-bar">
              <span>{bfChosen} of {bf.dates.length} selected</span>
              <button
                type="button"
                className="bf-link"
                onClick={() =>
                  setBackfill({ ...bf, dates: bf.dates.map((x) => ({ ...x, on: !bfAllOn })) })
                }
              >
                {bfAllOn ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="bf-list">
              {bf.dates.map((x, i) => (
                <label key={x.date} className="bf-row">
                  <input
                    type="checkbox"
                    checked={x.on}
                    onChange={() =>
                      setBackfill({
                        ...bf,
                        dates: bf.dates.map((y, j) => (j === i ? { ...y, on: !y.on } : y)),
                      })
                    }
                  />
                  <span>{fmtDayLabel(x.date)}</span>
                </label>
              ))}
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={() => setBackfill(null)} disabled={bf.busy}>Cancel</button>
              <button className="btn btn-save" onClick={saveBackfill} disabled={bf.busy || bfChosen === 0}>
                {bf.busy ? 'Saving…' : `Create ${bfChosen} ${bfChosen === 1 ? 'entry' : 'entries'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {agendaDays && (
        <div className="overlay" onClick={(e) => e.target.classList.contains('overlay') && setAgendaOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agenda-title"
            onKeyDown={trapTab}
          >
            <h2 id="agenda-title">Next 2 days</h2>
            {agendaDays.map((day) => (
              <div key={day.off} className="agenda-day">
                <h3>
                  {day.off === 0 ? 'Today' : 'Tomorrow'} · {day.label}
                  {day.parent && (
                    <span
                      className="agenda-parent"
                      style={{ background: softColor(day.parent.color), borderColor: day.parent.color }}
                    >
                      {day.parent.name}
                    </span>
                  )}
                </h3>
                {day.evs.length === 0 ? (
                  <div className="agenda-empty">No events</div>
                ) : (
                  day.evs.map((ev) => {
                    const t = TYPES[ev.type] || TYPES.other;
                    const ch = childMap[ev.child_id];
                    return (
                      <div
                        key={ev.id}
                        className="chip chip-ro"
                        style={{ background: t.soft, borderLeftColor: t.c }}
                      >
                        <div className="t">{fmtTime(ev.time)}</div>
                        <div className="ttl">{ev.title}</div>
                        <div className="meta">
                          <span className="dot" style={{ background: ch?.color || '#999' }} />
                          {ch?.name || '?'}
                          <CaregiverMeta ev={ev} caregiverMap={caregiverMap} />
                          {ev.who ? ` · ${ev.who}` : ''}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            ))}
            <div className="modal-actions">
              {/* autoFocus moves focus into the dialog on open so trapTab engages and
                  focus-restore (which relies on focus having entered the overlay) works. */}
              <button className="btn" autoFocus onClick={() => setAgendaOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}

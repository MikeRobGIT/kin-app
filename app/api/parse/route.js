export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { isAuthed } from '@/lib/auth';
import { TYPES, PD_KEYS, isTrip } from '@/lib/constants';
import { isRealDate, isRealTime } from '@/lib/validate';
import { normWeekdays, expandDates } from '@/lib/recurrence';

async function guard() {
  return (await isAuthed()) ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function todayYmd() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Natural-language -> a *draft* event for the user to confirm. Never inserts;
// the human confirms in the modal and the normal POST validates on save.
export async function POST(request) {
  const g = await guard();
  if (g) return g;

  const base = process.env.LITELLM_BASE_URL;
  const key = process.env.LITELLM_API_KEY;
  const model = process.env.LITELLM_MODEL;
  if (!base || !key || !model) {
    return NextResponse.json({ error: 'AI quick-add is not configured.' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const text = String(body?.text || '').trim();
  if (!text) return NextResponse.json({ error: 'Say what happened.' }, { status: 400 });

  // Only ACTIVE members — the parser must never file a note against an archived child/parent,
  // and "I/me" maps to the first active parent by sort (below).
  const children = db.prepare('SELECT id, name FROM children WHERE archived = 0 ORDER BY sort').all();
  const caregivers = db.prepare('SELECT id, name FROM caregivers WHERE archived = 0 ORDER BY sort').all();
  const today = todayYmd();
  const types = Object.entries(TYPES).map(([k, t]) => ({ key: k, label: t.label, trip: !!t.trip }));
  const primaryCg = caregivers[0]?.id || '';

  const sys = `You convert a parent's note about their child into ONE structured calendar entry as strict JSON. Today is ${today} (local time). Output ONLY a JSON object — no prose, no markdown.

Children (use the id): ${JSON.stringify(children)}
Caregivers / parents (use the id): ${JSON.stringify(caregivers)}
Activity types (use the key): ${JSON.stringify(types)}
Trip kinds for "pd" (ONLY when the chosen type has trip=true): ${JSON.stringify(PD_KEYS)}

Rules:
- child_id: match the child by name. If you cannot match a child, return {"error":"which child?"}.
- caregiver_id: who did it. "I"/"me"/"my"/"myself" -> "${primaryCg}". Match other names to a caregiver id; if unknown, use "".
- type: the single best-matching activity key. Driving/taking/dropping/picking up to a place (school, practice, appointment) is a trip type; hands-on care (meals, bedtime, bath, homework, etc.) is a caregiving type. If nothing fits, "other". An activity can still be a trip type when NOBODY drove — a school day spent learning from home, a camp week the bus collected her, a practice another family drove. Keep the real activity type in that case and set pd to "none"; do NOT switch to a caregiving type.
- pd: only when the chosen type has trip=true. "took"/"dropped off" -> "dropoff"; "picked up" -> "pickup"; "to and from"/"both ways" -> "both". An EXPLICIT statement that no drop-off or pickup happened ("nobody drove her", "no drop-off or pickup", "learning from home all day", "took the bus", "another family drove") -> "none"; if the note does not say so explicitly, never use "none" — pick the leg that happened. For non-trip types use null.
- date: resolve relative dates ("today","yesterday","last monday") to YYYY-MM-DD vs today; default today.
- time: "HH:MM" 24h if mentioned, else "08:00".
- title: short label, e.g. "School drop-off", "Dinner", "Dentist".
- who: only clearly-extra info (e.g. "with Grandma" -> "Grandma"), else "".
- notes: "" unless there's a meaningful extra detail.
- recurrence: usually null. Set it ONLY when the note describes a REPEATING schedule with a BOUNDED date range — both a start and an end (e.g. "on Tuesdays and Wednesdays every week from March 1 to May 30", "every day from Mar 1 until Mar 5"). Then set {"weekdays":[...],"from":"YYYY-MM-DD","to":"YYYY-MM-DD"} with lowercase 3-letter weekday tokens (mon,tue,wed,thu,fri,sat,sun). Expand shorthands into explicit tokens: "weekdays"->mon,tue,wed,thu,fri; "every day"/"daily"->all 7; "weekends"->sat,sun. Resolve from/to to concrete dates vs today. If the schedule is open-ended (no clear end), keep recurrence null. Even when recurrence is set, still fill "date" with the FIRST matching date in range.
- If you cannot identify both a child AND an activity, return {"error":"<short reason>"}.

JSON shape: {"child_id":"","caregiver_id":"","type":"","pd":null,"date":"YYYY-MM-DD","time":"HH:MM","title":"","who":"","notes":"","recurrence":null}`;

  let res;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: text },
        ],
      }),
    });
  } catch {
    return NextResponse.json({ error: 'AI service unreachable.' }, { status: 502 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: 'AI service error.' }, { status: 502 });
  }

  let parsed;
  try {
    const completion = await res.json();
    const content = String(completion?.choices?.[0]?.message?.content || '')
      .replace(/```json|```/gi, '')
      .trim();
    parsed = JSON.parse(content);
  } catch {
    return NextResponse.json(
      { error: "Couldn't read that — try rephrasing, or add it manually." },
      { status: 422 }
    );
  }
  if (parsed?.error) {
    return NextResponse.json({ error: String(parsed.error) }, { status: 422 });
  }

  // Sanitize into a draft. The human confirms and the POST re-validates on save.
  const childOk = children.some((c) => c.id === parsed.child_id);
  const typeOk = !!TYPES[parsed.type];
  if (!childOk || !typeOk) {
    return NextResponse.json(
      { error: "Couldn't match a child and activity — add it manually." },
      { status: 422 }
    );
  }
  const cgOk = caregivers.some((c) => c.id === parsed.caregiver_id);
  const draft = {
    title: String(parsed.title || TYPES[parsed.type].label).slice(0, 120),
    type: parsed.type,
    child_id: parsed.child_id,
    caregiver_id: cgOk ? parsed.caregiver_id : '',
    pd: isTrip(parsed.type) ? (PD_KEYS.includes(parsed.pd) ? parsed.pd : 'dropoff') : 'dropoff',
    date: isRealDate(parsed.date) ? parsed.date : today,
    time: isRealTime(parsed.time) ? parsed.time : '08:00',
    who: String(parsed.who || '').slice(0, 120),
    notes: String(parsed.notes || '').slice(0, 500),
  };

  // Recurring statement -> a backfill rule. The model gives the rule (NLU); we expand the
  // exact dates here (arithmetic). The human reviews/deselects, then bulk-saves.
  const rec = parsed.recurrence;
  const recValid =
    rec &&
    typeof rec === 'object' &&
    normWeekdays(rec.weekdays).length > 0 &&
    isRealDate(rec.from) &&
    isRealDate(rec.to) &&
    rec.from <= rec.to;
  if (recValid) {
    const { dates, truncated } = expandDates(rec.weekdays, rec.from, rec.to);
    if (dates.length) {
      const { date, ...base } = draft; // base = per-occurrence fields, minus the single date
      return NextResponse.json({
        recurrence: { base, dates, weekdays: normWeekdays(rec.weekdays), from: rec.from, to: rec.to, truncated },
      });
    }
  }

  return NextResponse.json({ draft });
}

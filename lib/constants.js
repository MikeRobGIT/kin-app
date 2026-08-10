export const TYPES = {
  // Transport — uses the pickup / drop-off selector (trip: true).
  school:      { label: 'School',         c: '#2d6a9f', soft: '#dde9f3', trip: true },
  tutor:       { label: 'Tutoring',       c: '#8a5a2b', soft: '#f0e5d6', trip: true },
  therapy:     { label: 'Therapy',        c: '#7b4f9e', soft: '#ece0f3', trip: true },
  // Trip-typed, unlike `medical` below: a course of orthodontics is a long run of recurring
  // appointments somebody has to drive to, so the leg is the part worth recording. That does mean
  // Orthodontist sits under Transport while Doctor / Dentist sits under Caregiving.
  ortho:       { label: 'Orthodontist',    c: '#0d8f9e', soft: '#d3edf1', trip: true },
  daycare:     { label: 'Daycare',        c: '#b08300', soft: '#f5edcf', trip: true },
  sport:       { label: 'Sports',         c: '#1f7a4d', soft: '#daf0e3', trip: true },
  gym:         { label: 'Gymnastics',     c: '#b5396b', soft: '#f6dde8', trip: true },
  camp:        { label: 'Camp',           c: '#1f7a8c', soft: '#d6edf1', trip: true },
  other:       { label: 'Other',          c: '#5a5a5a', soft: '#e7e7e4', trip: true },

  // Caregiving — hands-on parenting, no trip kind (trip: false).
  meal:        { label: 'Meals / Cooking',   c: '#c0622e', soft: '#f6e3d6' },
  bedtime:     { label: 'Bedtime',           c: '#3b4a8a', soft: '#dfe2f2' },
  bath:        { label: 'Bath / Hygiene',    c: '#2a8a8a', soft: '#d6efef' },
  morning:     { label: 'Morning routine',   c: '#9a7b1f', soft: '#f1e8cf' },
  homework:    { label: 'Homework help',     c: '#4a7a2b', soft: '#e2efd6' },
  schoolevent: { label: 'School event',      c: '#2f5d8a', soft: '#d9e6f2' },
  medical:     { label: 'Doctor / Dentist',  c: '#b03a4e', soft: '#f5dde2' },
  medication:  { label: 'Medication',        c: '#6e4f9e', soft: '#e8e0f3' },
  activity:    { label: 'Activity / Playdate', c: '#2a7d57', soft: '#d9efe4' },
  errand:      { label: 'Errand',            c: '#6a6a64', soft: '#e9e9e4' },
};

export const PD = { dropoff: 'DROP', pickup: 'PICK', both: 'BOTH' };

// Transport types use the pickup/drop-off selector; caregiving types don't.
export const isTrip = (type) => !!(TYPES[type] && TYPES[type].trip);

// '' is the subscription "from title" sentinel (calendar_subscriptions.type): the feed declares no
// activity and each imported event is typed from its own title. Every outcome of that resolution is
// trip-typed — every HINTS target in lib/ical-map.js, plus the `other` resort — so such a feed
// carries a leg exactly like a real trip type does. Used by the subscription validator, writes and
// Settings UI so the three can't drift.
export const takesLeg = (type) => type === '' || isTrip(type);

export const TYPE_KEYS = Object.keys(TYPES);
export const PD_KEYS = Object.keys(PD);

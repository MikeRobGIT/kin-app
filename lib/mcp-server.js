// Wraps the pure handlers (lib/mcp-tools.js) as MCP tools with zod input schemas and
// uniform content/error framing. Both route mount points call makeKinHandler(basePath).
import { z } from 'zod';
import { createMcpHandler } from 'mcp-handler';
import * as T from './mcp-tools.js';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const hm = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM');

// One event's writable fields (title/type/child are the required core; the rest optional).
const eventShape = {
  title: z.string().min(1).max(120),
  type: z.string().describe('an activity type key from get_context.types[].key'),
  child_id: z.string().describe('a child id from get_context.children — do NOT guess; call get_context first'),
  // Nullable: list_events returns caregiver_id: null for an unassigned event, so an agent must
  // be able to pass that value straight back to update_event. validateEvent/normalize already
  // treat null (and '') as "unassigned", so the lib layer accepts it — only the schema had to.
  caregiver_id: z.string().nullable().optional().describe('a parent id from get_context.caregivers; null/omit if unassigned'),
  // Distinct pickup-leg parent, only honored on a trip with pd='both' (else the lib layer forces it
  // null); lets an agent record e.g. one parent drops off and the other picks up. caregiver_id is the
  // drop-off / sole-leg parent.
  pickup_caregiver_id: z
    .string()
    .nullable()
    .optional()
    .describe("a parent id from get_context.caregivers for the pickup leg; only for a trip with pd='both' and different from caregiver_id"),
  // Hardcoded literal, deliberately kept in step with PD_KEYS (lib/constants.js), which get_context
  // advertises as pdKinds — add a new trip kind in BOTH places or an agent is offered a value this
  // boundary then rejects. The 'none' guidance is load-bearing: these tools write with no human in
  // the loop, and the month seal detects a later EDIT, not a wrong value at creation.
  pd: z
    .enum(['dropoff', 'pickup', 'both', 'none'])
    .optional()
    .describe(
      "trip kind; only for trip types. 'none' = the activity happened but no parent drove (child stayed home, took the bus, another family drove). Never use 'none' because you are unsure which leg happened — pick the leg that actually occurred."
    ),
  date: ymd,
  time: hm,
  who: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
};

export const TOOL_NAMES = [
  'get_context', 'list_events', 'involvement_report',
  'log_event', 'update_event', 'delete_event', 'log_events_bulk',
];

// Turn a plain handler into an MCP tool handler: data → text content; thrown Error → isError.
function wrap(fn) {
  return async (args) => {
    try {
      const data = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: String(e?.message || e) }], isError: true };
    }
  };
}

export function registerKinTools(server) {
  server.registerTool('get_context',
    { title: 'Get context', description: 'Children, caregivers, activity types, and trip kinds. Call first so you use real ids and type keys.', inputSchema: {} },
    wrap(() => T.getContext()));

  server.registerTool('list_events',
    { title: 'List events', description: 'Events in a date range plus the on-duty parent per day. Both dates required; span ≤400 days.', inputSchema: { from: ymd, to: ymd } },
    wrap((a) => T.listEvents(a)));

  server.registerTool('involvement_report',
    { title: 'Involvement report', description: 'Per-parent / per-activity-type counts over a date range. Both dates required; span ≤400 days.', inputSchema: { from: ymd, to: ymd } },
    wrap((a) => T.involvementReport(a)));

  server.registerTool('log_event',
    { title: 'Log event', description: 'Create one calendar event (transport or hands-on care).', inputSchema: eventShape },
    wrap((a) => T.logEvent(a)));

  server.registerTool('update_event',
    { title: 'Update event', description: 'Edit an existing event by id (all event fields required).', inputSchema: { id: z.string(), ...eventShape } },
    wrap((a) => T.updateEvent(a)));

  server.registerTool('delete_event',
    { title: 'Delete event', description: 'Delete an event by id (keeps an audit snapshot).', inputSchema: { id: z.string() } },
    wrap((a) => T.deleteEvent(a)));

  server.registerTool('log_events_bulk',
    { title: 'Log events (bulk)', description: 'Create many events at once (all-or-nothing). Set series=true to link them for later edit/delete as a unit.', inputSchema: { events: z.array(z.object(eventShape)).min(1), series: z.boolean().optional() } },
    wrap((a) => T.logEventsBulk(a)));
}

// The one MCP handler factory, shared by both route mounts (bearer header + capability URL)
// so their config can never drift. basePath differs per mount (the capability URL bakes the
// token into the path, so it is known only per-request).
export function makeKinHandler(basePath) {
  return createMcpHandler(
    (server) => registerKinTools(server),
    { serverInfo: { name: 'kin', version: '1.0.0' }, capabilities: { tools: {} } },
    { basePath }
  );
}

// Mark an MCP response uncacheable. Required for the login-less capability-URL mount (an
// intermediary proxy must not cache a response past token revocation — same rule as
// proxy.js does for /share); applied to both mounts for symmetry. Re-wraps to preserve the
// streamed body while setting a header the underlying response may have locked.
export function noStore(res) {
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return out;
}

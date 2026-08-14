import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { PD_KEYS } from '../lib/constants.js';

let registerKinTools, TOOL_NAMES;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mcpsrv-'));
  await import('../lib/db.js'); // seed the temp DB
  ({ registerKinTools, TOOL_NAMES } = await import('../lib/mcp-server.js'));
});

// Minimal fake of the SDK McpServer: records registrations and lets us invoke a handler.
function fakeServer() {
  const tools = new Map();
  return {
    registerTool: (name, config, handler) => tools.set(name, { config, handler }),
    tools,
  };
}

test('registers exactly the 7 tools, no schedule/seal/share tools', () => {
  const s = fakeServer();
  registerKinTools(s);
  assert.deepEqual([...s.tools.keys()].sort(), [...TOOL_NAMES].sort());
  assert.equal(s.tools.size, 7);
  for (const name of s.tools.keys()) {
    assert.doesNotMatch(name, /schedule|override|seal|share|caregiver/i);
  }
});

test('a write tool returns text content on success', async () => {
  const s = fakeServer();
  registerKinTools(s);
  const res = await s.tools.get('log_event').handler({
    title: 'Dinner', type: 'meal', child_id: 'c1', caregiver_id: 'g1',
    date: '2026-06-14', time: '18:00',
  });
  assert.equal(res.isError, undefined);
  const row = JSON.parse(res.content[0].text);
  assert.equal(row.title, 'Dinner');
});

test('a handler error becomes an isError result, not a throw', async () => {
  const s = fakeServer();
  registerKinTools(s);
  const res = await s.tools.get('log_event').handler({
    title: 'Bad', type: 'nope', child_id: 'c1', date: '2026-06-14', time: '18:00',
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Invalid type/);
});

// list_events returns caregiver_id: null for an unassigned event; the write schemas must
// accept that value back so an agent can round-trip an unassigned row through update_event.
test('event schema accepts a null caregiver_id (unassigned round-trip)', () => {
  const s = fakeServer();
  registerKinTools(s);
  const base = { id: 'e1', title: 'Snack', type: 'meal', child_id: 'c1', date: '2026-06-14', time: '18:00' };
  for (const name of ['update_event', 'log_event']) {
    const shape = s.tools.get(name).config.inputSchema;
    const r = z.object(shape).safeParse({ ...base, caregiver_id: null });
    assert.equal(r.success, true, `${name} should accept caregiver_id: null`);
  }
});

// The pd enum in lib/mcp-server.js is a hardcoded literal while get_context advertises PD_KEYS
// (derived). Without this pin the two drift silently: the whole suite stays green while an agent
// offered a documented trip kind gets rejected at the schema boundary.
test('the event schema accepts every advertised trip kind and nothing else', () => {
  const s = fakeServer();
  registerKinTools(s);
  const base = { id: 'e1', title: 'School', type: 'school', child_id: 'c1', date: '2026-06-14', time: '08:00' };
  for (const name of ['update_event', 'log_event']) {
    const shape = s.tools.get(name).config.inputSchema;
    for (const pd of PD_KEYS) {
      assert.equal(
        z.object(shape).safeParse({ ...base, pd }).success,
        true,
        `${name} should accept pd: ${pd} (advertised by get_context.pdKinds)`
      );
    }
    assert.equal(z.object(shape).safeParse({ ...base, pd: 'sideways' }).success, false);
  }
});

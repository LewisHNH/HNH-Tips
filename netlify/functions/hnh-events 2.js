// netlify/functions/hnh-events.js
//
// SELF-CONTAINED. Goes at:  netlify/functions/hnh-events.js
// Named hnh-* so it can never collide with your existing events.js.
//
// Write:
//   POST /.netlify/functions/hnh-events
//   Header: x-admin-password: YOUR_ADMIN_PASSWORD
//   { "type": "tip.settled", "sport": "greyhounds",
//     "payload": { "selection": "Trap 4", "tipster": "lewis",
//                  "advisedPrice": "5/2", "sp": "2/1",
//                  "stake": 1, "result": "win" } }
//
// Read:
//   GET /.netlify/functions/hnh-events?days=7

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'hnh-events';

const EVENT_TYPES = [
  'tip.posted',
  'tip.settled',
  'member.joined',
  'member.left',
  'sub.started',
  'sub.cancelled',
  'content.planned',
  'content.filmed',
  'content.published',
  'enquiry.received',
  'broadcast.sent',
  'brief.generated',
  'note',
];

async function getEventStore() {
  return getStore(STORE_NAME);
}

function ukDate(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(dt);
}

function addDays(isoDate, n) {
  const dt = new Date(`${isoDate}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

async function readDay(isoDate) {
  const store = await getEventStore();
  const raw = await store.get(`day/${isoDate}`, { type: 'json' });
  return Array.isArray(raw) ? raw : [];
}

async function appendEvent(event) {
  if (!event || !event.type) throw new Error('event.type is required');
  if (!EVENT_TYPES.includes(event.type)) {
    throw new Error(`unknown event type: ${event.type}`);
  }
  const ts = event.ts || new Date().toISOString();
  const stored = {
    id: 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    ts,
    type: event.type,
    actor: event.actor || 'system',
    sport: event.sport || null,
    payload: event.payload || {},
    v: 1,
  };
  const key = ukDate(ts);
  const day = await readDay(key);
  day.push(stored);
  const store = await getEventStore();
  await store.setJSON(`day/${key}`, day);
  return stored;
}

async function readRange(fromDate, toDate) {
  const out = [];
  let cursor = fromDate;
  let guard = 0;
  while (cursor <= toDate && guard < 400) {
    out.push(...(await readDay(cursor)));
    cursor = addDays(cursor, 1);
    guard++;
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (req) => {
  const headers = req.headers || {};
  const supplied = headers['x-admin-password'] || headers['X-Admin-Password'] || '';
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || supplied !== expected) return json(401, { error: 'unauthorised' });

  try {
    if (req.httpMethod === 'POST') {
      const body = JSON.parse(req.body || '{}');
      const list = Array.isArray(body) ? body : [body];
      const stored = [];
      for (const e of list) stored.push(await appendEvent(e));
      return json(200, { ok: true, stored });
    }

    if (req.httpMethod === 'GET') {
      const q = req.queryStringParameters || {};
      const to = q.to || ukDate();
      const from = q.from || (q.days
        ? addDays(to, -(Math.min(parseInt(q.days, 10) || 7, 180) - 1))
        : addDays(to, -6));
      return json(200, { ok: true, from, to, events: await readRange(from, to) });
    }

    return json(405, { error: 'method not allowed' });
  } catch (err) {
    console.error('hnh-events failed:', err);
    return json(400, { error: err.message });
  }
};

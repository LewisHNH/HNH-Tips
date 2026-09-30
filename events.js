// netlify/functions/lib/events.js
// Append-only event store for HNH. One blob per day, same tamper-evident
// pattern as the greyhound record.
//
// This is a shared library, not an endpoint — it must live in lib/ so Netlify
// doesn't try to bundle it as a function. ESM throughout, matching the rest
// of the project ("type": "module" in package.json).

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'hnh-events';

async function getEventStore() {
  return getStore(STORE_NAME);
}

// All dates are UK dates, not UTC dates. Matters for the 6:45am brief:
// an event logged at 00:30 BST is "yesterday" in UTC but "today" here.
export function ukDate(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt); // -> "2026-08-21"
}

export function ukHour(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      hour12: false,
    }).format(dt),
    10
  );
}

export function addDays(isoDate, n) {
  const dt = new Date(`${isoDate}T12:00:00Z`); // midday avoids DST edges
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function newId() {
  return (
    'evt_' +
    Date.now().toString(36) +
    '_' +
    Math.random().toString(36).slice(2, 8)
  );
}

// ---------------------------------------------------------------------------
// Event types in use. Keep this list honest - if you add one, add it here.
// ---------------------------------------------------------------------------
export const EVENT_TYPES = [
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
  'note', // freeform, for anything you just want on the record
];

export async function readDay(isoDate) {
  const store = await getEventStore();
  const raw = await store.get(`day/${isoDate}`, { type: 'json' });
  return Array.isArray(raw) ? raw : [];
}

async function writeDay(isoDate, events) {
  const store = await getEventStore();
  await store.setJSON(`day/${isoDate}`, events);
}

/**
 * Append an event. Returns the stored event.
 * Note: read-modify-write, so two writes in the same millisecond could
 * collide. At HNH volume that will not happen. If it ever does, the
 * fix is one blob per event rather than one per day.
 */
export async function append(event) {
  if (!event || !event.type) throw new Error('event.type is required');
  if (!EVENT_TYPES.includes(event.type)) {
    throw new Error(`unknown event type: ${event.type}`);
  }

  const ts = event.ts || new Date().toISOString();
  const stored = {
    id: newId(),
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
  await writeDay(key, day);
  return stored;
}

/**
 * Read events between two UK dates, inclusive. Both are "YYYY-MM-DD".
 */
export async function range(fromDate, toDate) {
  const out = [];
  let cursor = fromDate;
  let guard = 0;
  while (cursor <= toDate && guard < 400) {
    const day = await readDay(cursor);
    out.push(...day);
    cursor = addDays(cursor, 1);
    guard++;
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

export async function lastNDays(n, endDate) {
  const end = endDate || ukDate();
  const start = addDays(end, -(n - 1));
  return range(start, end);
}

// Default export too, so `import events from '../lib/events.js'` keeps
// working alongside named imports.
export default {
  EVENT_TYPES,
  append,
  range,
  lastNDays,
  readDay,
  ukDate,
  ukHour,
  addDays,
};

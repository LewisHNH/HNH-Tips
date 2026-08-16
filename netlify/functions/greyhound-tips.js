import { getStore } from '@netlify/blobs';
import { announceTip, announceResult } from './telegram.js';

// Its own store, so nothing here can collide with the horses data.
const STORE = 'hnh-greyhounds';
const DAY_PREFIX = 'day:';
const MONTH_PREFIX = 'month:';        // Exclusive Group monthly summaries
const FREE_MONTH_PREFIX = 'freemonth:'; // historical free-tip months, pre-dating this page

// How long after posting a tip can still be removed. Long enough to catch a
// typo, far too short to wait and see whether it wins.
const DELETE_WINDOW_MS = 15 * 60 * 1000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const store = () => getStore(STORE);

/**
 * A day record:
 * {
 *   date: '2026-08-14',
 *   tips: [{ id, time, track, trap, dog, oddsAdvised, book, oddsSP, points,
 *            result, tipster, notes, postedAt, settledAt }],
 *   members: { tips: 4, points: 6.2, settled: true }   // aggregate only, never selections
 * }
 */

function parseOdds(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'evs' || raw === 'evens' || raw === 'even') return 1;
  if (raw.includes('/')) {
    const [n, d] = raw.split('/');
    const num = Number(n);
    const den = Number(d);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    return num / den;
  }
  const dec = Number(raw);
  if (!Number.isFinite(dec) || dec <= 0) return null;
  return dec >= 2 ? dec - 1 : dec;
}

/** Points won or lost by one settled tip, at advised price. */
function tipReturn(tip) {
  if (!tip || tip.result === 'pending' || tip.result === 'void') return 0;
  const stake = Number(tip.points) || 0;
  if (tip.result === 'lose') return -stake;
  const odds = parseOdds(tip.oddsAdvised);
  return odds === null ? -stake : stake * odds;
}

// Accepts the same PIN as /api/tips, so there's one password for the whole admin.
// Set HNH_ADMIN_TOKEN to the same value as your existing admin password.
function isAdmin(request) {
  const token = process.env.HNH_ADMIN_TOKEN || process.env.ADMIN_PASSWORD;
  if (!token) return false;
  const supplied =
    request.headers.get('x-admin-password') || request.headers.get('x-hnh-admin');
  return supplied === token;
}

async function readDay(date) {
  const record = await store().get(`${DAY_PREFIX}${date}`, { type: 'json' });
  return record || { date, tips: [], members: null };
}

async function writeDay(day) {
  await store().setJSON(`${DAY_PREFIX}${day.date}`, day);
  return day;
}

async function readAllDays() {
  const { blobs } = await store().list({ prefix: DAY_PREFIX });
  const days = await Promise.all(
    blobs.map((b) => store().get(b.key, { type: 'json' }))
  );
  return days.filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}

async function readMonthsWithPrefix(prefix) {
  const { blobs } = await store().list({ prefix });
  const months = await Promise.all(blobs.map((b) => store().get(b.key, { type: 'json' })));
  return months.filter(Boolean).sort((a, b) => a.month.localeCompare(b.month));
}

// list({ prefix: 'month:' }) would also match 'freemonth:' keys on some backends,
// so filter defensively rather than relying on prefix matching alone.
const readAllMonths = async () =>
  (await readMonthsWithPrefix(MONTH_PREFIX)).filter((m) => m.kind !== 'free');
const readAllFreeMonths = () => readMonthsWithPrefix(FREE_MONTH_PREFIX);

/** Public shape — strips anything members-only down to an aggregate. */
function publicDay(day) {
  return {
    date: day.date,
    tips: day.tips || [],
    members:
      day.members && day.members.settled
        ? { tips: day.members.tips, points: day.members.points }
        : null,
  };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  try {
    if (method === 'GET') {
      const date = url.searchParams.get('date');
      if (date) return json(publicDay(await readDay(date)));

      const [days, months, freeMonths] = await Promise.all([
        readAllDays(), readAllMonths(), readAllFreeMonths(),
      ]);
      return json({ days: days.map(publicDay), months, freeMonths });
    }

    if (!isAdmin(request)) return json({ error: 'Not authorised' }, 401);

    const body = await request.json();

    // Add a tip to a day.
    if (method === 'POST') {
      const { date } = body;
      if (!date) return json({ error: 'Missing date' }, 400);

      const day = await readDay(date);
      const tip = {
        id: body.id || `${date}-${Date.now().toString(36)}`,
        time: body.time || '',
        track: body.track || '',
        trap: Number(body.trap) || null,
        dog: body.dog || '',
        oddsAdvised: body.oddsAdvised || '',
        book: body.book || '',            // where the advised price was available
        oddsSP: body.oddsSP || '',
        points: Number(body.points) || 1,
        result: body.result || 'pending',
        tipster: body.tipster || 'Lewis',
        notes: body.notes || '',
        postedAt: new Date().toISOString(),
      };

      day.tips = [...(day.tips || []), tip];
      await writeDay(day);

      // Telegram is best-effort — a failure here must not lose the tip.
      const telegram = body.notify === false ? { skipped: 'opted out' } : await announceTip(tip);

      return json({ ok: true, tip, telegram, day: publicDay(day) });
    }

    // Set or update a month of Exclusive Group results.
    // Months are summary figures only — never individual member selections.
    if (method === 'PUT') {
      const { month } = body;
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return json({ error: 'Month must be YYYY-MM' }, 400);
      }
      const isFree = body.kind === 'free';
      const record = {
        month,
        kind: isFree ? 'free' : 'group',
        tips: Number(body.tips) || 0,
        points: Number(body.points) || 0,
        staked: Number(body.staked) || 0,
        winners: Number(body.winners) || 0,
        updatedAt: new Date().toISOString(),
      };
      await store().setJSON(`${isFree ? FREE_MONTH_PREFIX : MONTH_PREFIX}${month}`, record);
      return json({ ok: true, month: record });
    }

    // Settle a tip, or set the members' aggregate for the day.
    // Deliberately append-only: tips cannot be removed, and a settled result
    // cannot be silently changed. Both are what make the record trustworthy.
    if (method === 'PATCH') {
      const { date } = body;
      if (!date) return json({ error: 'Missing date' }, 400);
      const day = await readDay(date);

      if (body.members) {
        day.members = {
          tips: Number(body.members.tips) || 0,
          points: Number(body.members.points) || 0,
          settled: body.members.settled !== false,
        };
      }

      let telegram = { skipped: 'no result change' };

      if (body.tipId) {
        const tip = (day.tips || []).find((t) => t.id === body.tipId);
        if (!tip) return json({ error: 'Tip not found' }, 404);

        if (tip.result && tip.result !== 'pending' && body.result && body.result !== tip.result) {
          return json({
            error: `Already settled as ${tip.result}. Settled results cannot be changed.`,
          }, 409);
        }

        if (body.oddsSP !== undefined) tip.oddsSP = body.oddsSP;

        const changed = body.result && body.result !== tip.result;
        if (body.result) tip.result = body.result;
        if (body.result && body.result !== 'pending') tip.settledAt = new Date().toISOString();

        await writeDay(day);

        if (changed && body.result !== 'pending' && body.notify !== false) {
          const all = await readAllDays();
          const flat = all.flatMap((d) => d.tips || []);
          const running = flat.reduce((sum, t) => sum + tipReturn(t), 0);
          telegram = await announceResult(tip, tipReturn(tip), running);
        }

        return json({ ok: true, telegram, day: publicDay(day) });
      }

      await writeDay(day);
      return json({ ok: true, telegram, day: publicDay(day) });
    }

    // Delete a tip — only while pending, and only within the grace window.
    // This is the narrowest hole that still fixes a typo: by the time a race
    // has run you can no longer remove the selection, so a loser can't vanish.
    if (method === 'DELETE') {
      const { date, tipId } = body;
      if (!date || !tipId) return json({ error: 'Missing date or tipId' }, 400);

      const day = await readDay(date);
      const tip = (day.tips || []).find((t) => t.id === tipId);
      if (!tip) return json({ error: 'Tip not found' }, 404);

      if (tip.result && tip.result !== 'pending') {
        return json({ error: 'Settled tips cannot be deleted.' }, 409);
      }

      const age = Date.now() - new Date(tip.postedAt || 0).getTime();
      if (!Number.isFinite(age) || age > DELETE_WINDOW_MS) {
        return json({
          error: 'Past the 15 minute window — this tip is now part of the record.',
        }, 409);
      }

      day.tips = (day.tips || []).filter((t) => t.id !== tipId);
      // Tombstone, so the count of removed tips is auditable even though the
      // selection itself is gone.
      day.removed = [...(day.removed || []), {
        id: tipId, dog: tip.dog, removedAt: new Date().toISOString(),
      }];
      await writeDay(day);
      return json({ ok: true, day: publicDay(day) });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    return json({ error: error.message || 'Something went wrong' }, 500);
  }
}

export const config = { path: '/api/greyhound-tips' };

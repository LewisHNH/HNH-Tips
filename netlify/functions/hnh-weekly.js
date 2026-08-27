// netlify/functions/hnh-weekly.js
//
// Sunday evening review. The brief is about today; this is about the week
// just gone and the one coming - the step back you would otherwise never
// make time for.
//
// netlify.toml:
//   [functions."hnh-weekly"]
//     schedule = "0 19 * * 0"
//
// That is 19:00 UTC Sunday, so 20:00 UK in summer and 19:00 in winter.
// Close enough for a weekly - it is not time-critical like the brief.
//
// Manual: /.netlify/functions/hnh-weekly?pw=PASSWORD&dry=1

import { getStore } from '@netlify/blobs';

const EVENTS_STORE = 'hnh-events';
const GREY_STORE = 'hnh-greyhounds';
const TIPS_STORE = 'hnh-tips';
const MODEL = 'claude-sonnet-5';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function ukDate(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(dt);
}

function addDays(iso, n) {
  const dt = new Date(`${iso}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function toDecimal(p) {
  if (p == null || p === '') return null;
  if (typeof p === 'number') return p;
  const s = String(p).trim().toLowerCase();
  if (['evens', 'evs', '1/1'].includes(s)) return 2;
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    return isFinite(n) && isFinite(d) && d ? n / d + 1 : null;
  }
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function normaliseResult(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || s === 'pending' || s === 'tbc') return 'pending';
  if (['won', 'win', 'winner', 'w'].includes(s)) return 'win';
  if (['lost', 'lose', 'loser', 'l', 'unplaced'].includes(s)) return 'lose';
  if (['placed', 'place', 'p'].includes(s)) return 'placed';
  if (['void', 'nr', 'withdrawn'].includes(s)) return 'void';
  return 'unknown';
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tg(method, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.BRAIN_BOT_TOKEN}/${method}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return res.json();
}

// --- data ------------------------------------------------------------------

async function trapBetween(from, to) {
  const store = getStore(GREY_STORE);
  const listed = await store.list();
  const keys = (listed.blobs || [])
    .map((b) => b.key)
    .filter((k) => k.startsWith('day:'))
    .filter((k) => {
      const d = k.replace('day:', '');
      return d >= from && d <= to;
    });

  const blobs = await Promise.all(
    keys.map(async (k) => { try { return await store.get(k, { type: 'json' }); } catch { return null; } })
  );

  const out = [];
  for (const d of blobs) {
    if (!d) continue;
    for (const t of d.tips || []) {
      const stake = Number(t.points) || 0;
      const dec = toDecimal(t.oddsAdvised);
      const result = normaliseResult(t.result);
      let profit = null;
      if (result === 'win' && stake && dec) profit = stake * (dec - 1);
      else if (result === 'lose' && stake) profit = -stake;
      else if (result === 'void') profit = 0;
      out.push({ date: d.date, name: t.dog, track: t.track, odds: t.oddsAdvised, stake, result, profit });
    }
  }
  return out;
}

async function horsesBetween(from, to) {
  try {
    const all = await getStore(TIPS_STORE).get('days', { type: 'json' });
    if (!all) return [];
    const out = [];
    for (const [date, day] of Object.entries(all)) {
      if (date < from || date > to) continue;
      for (const t of day.tips || []) {
        const stake = Number(t.stake) || 0;
        const dec = toDecimal(t.price);
        const result = normaliseResult(t.result);
        const isEW = String(t.betType || '').toLowerCase() === 'ew';
        let profit = null;
        if (result !== 'pending' && result !== 'unknown' && stake && dec) {
          if (result === 'void') profit = 0;
          else if (!isEW) profit = result === 'win' ? stake * (dec - 1) : -stake;
          else {
            const win = result === 'win' ? stake * (dec - 1) : -stake;
            const place = (result === 'win' || result === 'placed') ? stake * ((dec - 1) * 0.2) : -stake;
            profit = win + place;
          }
        }
        out.push({
          date, name: t.horse, course: t.course, tipster: t.tipster,
          odds: t.price, sp: t.sp, stake, outlay: isEW ? stake * 2 : stake, result, profit,
        });
      }
    }
    return out;
  } catch { return []; }
}

function summarise(items) {
  const settled = items.filter((i) => i.profit !== null && i.result !== 'pending');
  const staked = settled.reduce((a, i) => a + (i.outlay ?? i.stake ?? 0), 0);
  const profit = settled.reduce((a, i) => a + i.profit, 0);
  const wins = settled.filter((i) => i.result === 'win').length;
  return {
    bets: settled.length,
    wins,
    profitPts: round2(profit),
    stakedPts: round2(staked),
    roiPct: staked ? round2((profit / staked) * 100) : null,
    strikePct: settled.length ? round2((wins / settled.length) * 100) : null,
    pending: items.filter((i) => i.result === 'pending').length,
  };
}

async function readJson(path) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), 5000);
  try {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
    const res = await fetch(
      `${base}/.netlify/functions/${path}pw=${encodeURIComponent(process.env.ADMIN_PASSWORD)}`,
      { signal: c.signal }
    );
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

async function eventsBetween(from, to) {
  const store = getStore(EVENTS_STORE);
  const dates = [];
  let c = from;
  while (c <= to) { dates.push(c); c = addDays(c, 1); }
  const chunks = await Promise.all(
    dates.map(async (d) => {
      try {
        const raw = await store.get(`day/${d}`, { type: 'json' });
        return Array.isArray(raw) ? raw : [];
      } catch { return []; }
    })
  );
  return chunks.flat().filter((e) => !e.voidedAt);
}

// --- build -----------------------------------------------------------------

async function buildReview() {
  const today = ukDate();
  const weekEnd = today;
  const weekStart = addDays(today, -6);
  const prevStart = addDays(today, -13);
  const prevEnd = addDays(today, -7);

  const [trapThis, trapPrev, horsesThis, horsesPrev, whop, funnel, events, memory] =
    await Promise.all([
      trapBetween(weekStart, weekEnd),
      trapBetween(prevStart, prevEnd),
      horsesBetween(weekStart, weekEnd),
      horsesBetween(prevStart, prevEnd),
      readJson('hnh-whop?'),
      readJson('hnh-track?days=14&'),
      eventsBetween(weekStart, weekEnd),
      getStore(EVENTS_STORE).get('memory/notes', { type: 'json' }).catch(() => []),
    ]);

  const published = events.filter((e) => e.type === 'content.published');
  const byPlatform = {};
  for (const e of published) {
    const p = (e.payload && e.payload.platform) || 'unknown';
    byPlatform[p] = (byPlatform[p] || 0) + 1;
  }

  return {
    week: { from: weekStart, to: weekEnd },
    thisWeek: {
      freeTrap: summarise(trapThis),
      horses: summarise(horsesThis),
    },
    lastWeek: {
      freeTrap: summarise(trapPrev),
      horses: summarise(horsesPrev),
    },
    revenue: whop ? {
      activeMembers: whop.activeMembers,
      mrr: whop.mrr,
      cancellingAtPeriodEnd: whop.cancellingAtPeriodEnd,
      joinedLast30Days: whop.joinedLast30Days,
      cancelledLast30Days: whop.cancelledLast30Days,
      retention: whop.retention,
      capacity: whop.capacity,
    } : { error: 'Whop unavailable' },
    funnel: funnel && funnel.dataPresent ? funnel.funnel : { note: 'no funnel data' },
    content: {
      publishedThisWeek: published.length,
      byPlatform,
    },
    memory: Array.isArray(memory) ? memory.slice(-15) : [],
  };
}

const SYSTEM = `You are writing Lewis's Sunday evening review for Hooves & Hounds, a UK horse racing and greyhound tipping service.

You get pre-computed figures. Every number you state must come from them - never calculate or estimate anything that isn't there.

Keep these separate and never combine them: the paid Exclusive Group (the only revenue), the free Trap of the Day, and the free horse tips.

Write it as five short sections, no headings longer than three words:
1. How the week went - the numbers, and whether it was better or worse than the week before.
2. The one thing that stood out - good or bad, whichever is more useful.
3. Revenue and members - what moved, and what it means.
4. What went out - content published, and any platform that went quiet.
5. One thing to do this week - a single specific action, not a list.

Style: Lewis is reading this on a phone on a Sunday night. Plain UK English, direct, no preamble, no motivational filler. Under 300 words total. If something is missing from the data, say so rather than glossing over it. Be honest when a week was poor - he can see the numbers anyway, and pretending otherwise makes the good weeks mean less.`;

async function writeReview(data) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 900,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `This week's figures:\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`\n\nWrite the Sunday review.`,
      }],
    }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  return (d.content || []).map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
}

function mdToHtml(md) {
  let t = esc(md);
  t = t.replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

export default async (req) => {
  const url = new URL(req.url || 'https://x/');
  const forced = url.searchParams.has('pw');
  if (forced && url.searchParams.get('pw') !== process.env.ADMIN_PASSWORD) {
    return new Response('unauthorised', { status: 401 });
  }

  try {
    const data = await buildReview();
    const review = await writeReview(data);
    const text = `<b>WEEK IN REVIEW</b>\n<i>${esc(data.week.from)} to ${esc(data.week.to)}</i>\n\n${mdToHtml(review)}`;

    if (url.searchParams.get('dry') === '1') {
      return new Response(text.replace(/<[^>]+>/g, ''), {
        status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const chatId = process.env.BRIEF_CHAT_ID;
    if (!chatId) throw new Error('BRIEF_CHAT_ID is not set');
    await tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML', text, disable_web_page_preview: true,
    });

    return new Response('sent', { status: 200 });
  } catch (err) {
    console.error('weekly failed:', err);
    return new Response(`weekly failed: ${err.message}`, { status: 500 });
  }
};

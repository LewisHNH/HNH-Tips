// netlify/functions/hnh-brief.js
//
// The 6:45 morning brief. Reads the REAL stores, not just the event log:
//   hnh-greyhounds  day:   free Trap of the Day
//                   month: paid Exclusive Group
//   hnh-tips        days:  per-bet horse tips
//   hnh-events      content pipeline, memory, anything logged by voice
//   hnh-whop        members and revenue
//
// Triggered by hnh-cron at 06:45 UK. Not scheduled itself, so it stays
// reachable over HTTP for testing.
//
//   /.netlify/functions/hnh-brief?pw=PASSWORD
//   /.netlify/functions/hnh-brief?pw=PASSWORD&dry=1   preview, sends nothing

import { getStore } from '@netlify/blobs';

// ===========================================================================
// ==  EDIT THIS. Everything below is machinery.                            ==
// ===========================================================================

const FIXTURES = [
  { name: 'St Leger Festival', from: '2026-09-10', to: '2026-09-13' },
  { name: 'Irish Champions Weekend', from: '2026-09-12', to: '2026-09-13' },
  { name: 'Goodwood Season Finale', from: '2026-10-11', to: '2026-10-11' },
  { name: 'QIPCO British Champions Day', from: '2026-10-17', to: '2026-10-17' },
  { name: 'Cheltenham Showcase', from: '2026-10-23', to: '2026-10-24' },
  { name: 'Cheltenham November Meeting', from: '2026-11-13', to: '2026-11-15' },
];

const RULES = [
  {
    id: 'fixture-preview',
    match: (c) => !!c.fixture,
    tasks: (c) => [{
      title: `${c.fixture.name} preview - 30-40s vertical`,
      platform: 'tiktok', filmBy: '11:00', postAt: '12:30',
      note: 'Analysis framing. Selection at the end for completion.',
    }],
  },
  {
    id: 'saturday-card',
    match: (c) => c.dow === 6 && !c.fixture,
    tasks: () => [{
      title: 'Saturday card walkthrough',
      platform: 'tiktok', filmBy: '10:30', postAt: '12:30',
      note: 'Two races max. Biggest betting day of the week.',
    }],
  },
  {
    id: 'big-winner',
    match: (c) => c.bigWinners.length > 0,
    tasks: (c) => [{
      title: `Result clip - ${c.bigWinners[0]}`,
      platform: 'instagram', filmBy: '17:00', postAt: '19:00',
      note: 'Advised price vs SP is the story, not the profit figure.',
    }],
  },
  {
    id: 'sunday-review',
    match: (c) => c.dow === 0,
    tasks: () => [{
      title: 'Weekly P&L card, both codes',
      platform: 'x', filmBy: null, postAt: '20:00',
      note: 'Check the numbers before it goes.',
    }],
  },
  {
    id: 'greyhounds-noon',
    match: () => true,
    tasks: () => [{
      title: 'Greyhound tips — free trap + Exclusive Group',
      platform: 'telegram', filmBy: null, postAt: '12:00',
      note: 'Judges in by 11:00 so both go out together at noon.',
    }],
  },
  {
    id: 'horses-evening',
    match: () => true,
    tasks: () => [{
      title: 'Free horse tips for tomorrow',
      platform: 'telegram', filmBy: null, postAt: '18:00',
      note: 'Nath\'s in too. Next-day cards.',
    }],
  },
];

// ===========================================================================
// ==  Machinery                                                            ==
// ===========================================================================

const EVENTS_STORE = 'hnh-events';
const GREY_STORE = 'hnh-greyhounds';
const TIPS_STORE = 'hnh-tips';

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

function toDecimal(price) {
  if (price == null || price === '') return null;
  if (typeof price === 'number') return price;
  const s = String(price).trim().toLowerCase();
  if (['evens', 'evs', '1/1'].includes(s)) return 2;
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    if (!isFinite(n) || !isFinite(d) || d === 0) return null;
    return n / d + 1;
  }
  const num = Number(s);
  return isFinite(num) ? num : null;
}

function normaliseResult(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || s === 'pending' || s === 'tbc') return 'pending';
  if (['won', 'win', 'winner', 'w'].includes(s)) return 'win';
  if (['lost', 'lose', 'loser', 'l', 'unplaced'].includes(s)) return 'lose';
  if (['placed', 'place', 'p'].includes(s)) return 'placed';
  if (['void', 'nr', 'non-runner', 'withdrawn'].includes(s)) return 'void';
  return 'unknown';
}

// --- free Trap of the Day (day: records) -----------------------------------

async function readTrap(fromDate, toDate) {
  const store = getStore(GREY_STORE);
  const listed = await store.list();
  const keys = (listed.blobs || [])
    .map((b) => b.key)
    .filter((k) => k.startsWith('day:'))
    .filter((k) => {
      const d = k.replace('day:', '');
      return d >= fromDate && d <= toDate;
    });

  const days = await Promise.all(
    keys.map(async (k) => {
      try { return await store.get(k, { type: 'json' }); } catch { return null; }
    })
  );

  const tips = [];
  for (const d of days) {
    if (!d) continue;
    for (const t of d.tips || []) {
      const stake = Number(t.points) || 0;
      const dec = toDecimal(t.oddsAdvised);
      const result = normaliseResult(t.result);
      let profit = null;
      if (result === 'win' && stake && dec) profit = stake * (dec - 1);
      else if (result === 'lose' && stake) profit = -stake;
      else if (result === 'void') profit = 0;
      tips.push({
        date: d.date, dog: t.dog, track: t.track, trap: t.trap,
        odds: t.oddsAdvised, stake, result, profit,
      });
    }
  }
  return tips;
}

// --- paid group monthly aggregates -----------------------------------------

async function readPaidMonth(month) {
  try {
    const v = await getStore(GREY_STORE).get(`month:${month}`, { type: 'json' });
    if (!v) return null;
    const staked = Number(v.staked) || 0;
    const points = Number(v.points) || 0;
    return {
      tips: Number(v.tips) || 0,
      winners: Number(v.winners) || 0,
      staked: round2(staked),
      points: round2(points),
      roi: staked ? round2((points / staked) * 100) : null,
    };
  } catch { return null; }
}

// --- horse tips ------------------------------------------------------------

async function readHorses() {
  try {
    const days = await getStore(TIPS_STORE).get('days', { type: 'json' });
    if (!days || typeof days !== 'object') return [];
    const out = [];
    for (const [date, day] of Object.entries(days)) {
      for (const t of day.tips || []) {
        const stake = Number(t.stake) || 0;
        const dec = toDecimal(t.price);
        const result = normaliseResult(t.result);
        const isEW = String(t.betType || '').toLowerCase() === 'ew';
        const frac = (() => {
          const s = String(t.placeTerms || '1/5');
          const [n, d] = s.split('/').map(Number);
          return isFinite(n) && isFinite(d) && d ? n / d : 0.2;
        })();

        let profit = null;
        if (result !== 'pending' && result !== 'unknown' && stake && dec) {
          if (result === 'void') profit = 0;
          else if (!isEW) profit = result === 'win' ? stake * (dec - 1) : -stake;
          else {
            const win = result === 'win' ? stake * (dec - 1) : -stake;
            const place = (result === 'win' || result === 'placed')
              ? stake * ((dec - 1) * frac) : -stake;
            profit = win + place;
          }
        }
        const mp = t.manualPts;
        if (mp !== undefined && mp !== null && String(mp).trim() !== '' && isFinite(Number(mp))) {
          profit = Number(mp);
        }

        out.push({
          date, tipster: t.tipster, horse: t.horse, course: t.course,
          price: t.price, result, profit,
          outlay: isEW ? stake * 2 : stake,
          time: t.time,
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
    profit: round2(profit),
    roi: staked ? round2((profit / staked) * 100) : null,
    pending: items.filter((i) => i.result === 'pending').length,
  };
}

// --- events ----------------------------------------------------------------

async function readEvents(from, to) {
  const store = getStore(EVENTS_STORE);
  const days = [];
  let c = from;
  while (c <= to) { days.push(c); c = addDays(c, 1); }
  const chunks = await Promise.all(
    days.map(async (d) => {
      try {
        const raw = await store.get(`day/${d}`, { type: 'json' });
        return Array.isArray(raw) ? raw : [];
      } catch { return []; }
    })
  );
  return chunks.flat().filter((e) => !e.voidedAt);
}

async function readWhop() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
    const res = await fetch(
      `${base}/.netlify/functions/hnh-whop?pw=${encodeURIComponent(process.env.ADMIN_PASSWORD)}`,
      { signal: controller.signal }
    );
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

// --- telegram --------------------------------------------------------------

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendMessage(chatId, text) {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.BRAIN_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
      }),
    }
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram: ${data.description}`);
  return data.result;
}

// --- the brief -------------------------------------------------------------

const fmt = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)} pts`);

function prettyDate(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  }).format(new Date(`${iso}T12:00:00Z`));
}

function fixtureFor(date) {
  return FIXTURES.find((f) => date >= f.from && date <= f.to) || null;
}

async function buildBrief() {
  const today = ukDate();
  const yesterday = addDays(today, -1);
  const monthStart = `${today.slice(0, 7)}-01`;
  const month = today.slice(0, 7);

  const [trapMonth, paidMonth, horses, events, whop] = await Promise.all([
    readTrap(monthStart, today),
    readPaidMonth(month),
    readHorses(),
    readEvents(addDays(today, -13), today),
    readWhop(),
  ]);

  const trapY = trapMonth.filter((t) => t.date === yesterday);
  const horsesY = horses.filter((h) => h.date === yesterday);
  const horsesM = horses.filter((h) => h.date >= monthStart);

  const yTrap = summarise(trapY);
  const yHorses = summarise(horsesY);
  const mTrap = summarise(trapMonth);
  const mHorses = summarise(horsesM);

  const bigWinners = [...trapY, ...horsesY]
    .filter((t) => t.result === 'win')
    .filter((t) => (toDecimal(t.odds || t.price) || 0) >= 9)
    .map((t) => `${t.dog || t.horse} (${t.odds || t.price})`);

  // Content pipeline gaps
  const byRef = new Map();
  for (const e of events) {
    if (!e.type || !e.type.startsWith('content.')) continue;
    const ref = e.payload && e.payload.ref;
    if (!ref) continue;
    if (!byRef.has(ref)) byRef.set(ref, { title: ref, planned: null, filmed: null, published: null });
    const it = byRef.get(ref);
    it[e.type.split('.')[1]] = e.ts;
    if (e.payload.title) it.title = e.payload.title;
  }
  const pipeline = [...byRef.values()];
  const unfilmed = pipeline.filter((i) => i.planned && !i.filmed);
  const stale = pipeline.filter(
    (i) => i.filmed && !i.published && (Date.now() - new Date(i.filmed)) / 36e5 > 48
  );

  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const fixture = fixtureFor(today);
  const tasks = [];
  for (const r of RULES) {
    try {
      if (r.match({ dow, fixture, bigWinners })) tasks.push(...r.tasks({ dow, fixture, bigWinners }));
    } catch { /* a broken rule shouldn't kill the brief */ }
  }
  tasks.sort((a, b) => (a.postAt || '99:99').localeCompare(b.postAt || '99:99'));

  // ---- compose ----
  const L = [];
  L.push(`<b>HNH BRIEF — ${esc(prettyDate(today))}</b>`);
  if (fixture) L.push(`<i>${esc(fixture.name)}</i>`);
  L.push('');

  L.push('<b>Yesterday</b>');
  L.push(esc(yHorses.bets
    ? `Horses: ${yHorses.wins}/${yHorses.bets} · ${fmt(yHorses.profit)}`
    : 'Horses: nothing settled'));
  L.push(esc(yTrap.bets
    ? `Free trap: ${yTrap.wins}/${yTrap.bets} · ${fmt(yTrap.profit)}`
    : 'Free trap: nothing settled'));
  L.push('');

  L.push('<b>Month to date</b>');
  L.push(esc(`Horses ${fmt(mHorses.profit)}${mHorses.roi != null ? ` · ROI ${mHorses.roi}%` : ''}`));
  L.push(esc(`Free trap ${fmt(mTrap.profit)}${mTrap.roi != null ? ` · ROI ${mTrap.roi}%` : ''}`));
  if (paidMonth) {
    L.push(esc(`Paid group ${fmt(paidMonth.points)} · ${paidMonth.winners}/${paidMonth.tips} · ROI ${paidMonth.roi}%`));
  }
  if (whop && whop.activeMembers != null) {
    const risk = whop.cancellingAtPeriodEnd
      ? ` · ${whop.cancellingAtPeriodEnd} cancelling`
      : '';
    L.push(esc(`${whop.activeMembers} members · £${whop.mrr} MRR${risk}`));
  }
  L.push('');

  L.push('<b>Today</b>');
  if (!tasks.length) L.push('Nothing scheduled.');
  for (const t of tasks) {
    L.push(esc(`${t.postAt || 'anytime'} ${t.platform} — ${t.title}${t.filmBy ? ` · film by ${t.filmBy}` : ''}`));
    if (t.note) L.push(`  <i>${esc(t.note)}</i>`);
  }

  // ---- the nag: three lines maximum or it stops being read ----
  const nags = [];
  const pendingHorses = horses.filter((h) => h.result === 'pending' && h.date < today).length;
  if (pendingHorses) nags.push(`${pendingHorses} horse tip${pendingHorses > 1 ? 's' : ''} still unsettled`);
  if (unfilmed.length) nags.push(`${unfilmed.length} planned, not filmed`);
  if (stale.length) nags.push(`"${stale[0].title}" filmed but unposted 48h+`);
  if (whop && whop.membersNeedingAction && whop.membersNeedingAction.length) {
    const expired = whop.membersNeedingAction.filter((m) => m.action.startsWith('EXPIRED'));
    if (expired.length) nags.push(`${expired.length} expired member${expired.length > 1 ? 's' : ''} to remove from the group`);
  }

  if (nags.length) {
    L.push('');
    L.push('<b>Chasing you</b>');
    for (const n of nags.slice(0, 3)) L.push(esc(`• ${n}`));
  }

  return L.join('\n');
}

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('pw') !== process.env.ADMIN_PASSWORD) {
    return new Response('unauthorised', { status: 401 });
  }

  try {
    const chatId = process.env.BRIEF_CHAT_ID;
    if (!chatId) throw new Error('BRIEF_CHAT_ID is not set');
    const text = await buildBrief();

    if (url.searchParams.get('dry') === '1') {
      return new Response(text.replace(/<[^>]+>/g, ''), {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    await sendMessage(chatId, text);
    return new Response('sent', { status: 200 });
  } catch (err) {
    console.error('brief failed:', err);
    return new Response(`brief failed: ${err.message}`, { status: 500 });
  }
};

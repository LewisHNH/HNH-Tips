// netlify/functions/hnh-alerts.js
//
// Watches for things worth knowing before you think to ask. Runs twice a
// day; only speaks when something has actually changed, because an alert
// that fires every day stops being an alert.
//
// netlify.toml:
//   [functions."hnh-alerts"]
//     schedule = "0 11,20 * * *"
//
// Manual: /.netlify/functions/hnh-alerts?pw=PASSWORD&force=1

import { getStore } from '@netlify/blobs';

const EVENTS_STORE = 'hnh-events';
const GREY_STORE = 'hnh-greyhounds';
const TIPS_STORE = 'hnh-tips';
const STATE_KEY = 'alerts/state';

// ---------------------------------------------------------------------------
// Thresholds. Tune these - too sensitive and you stop reading them.
// ---------------------------------------------------------------------------
const LOSING_RUN_ALERT = 5;        // consecutive losers before flagging
const DRAWDOWN_ALERT_PTS = -10;    // rolling 14-day loss that needs addressing
const QUIET_PLATFORM_DAYS = 5;     // nothing published for this long
const MRR_CHANGE_ALERT = 30;       // pounds of movement worth mentioning

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

async function recentTrapTips(days = 21) {
  const store = getStore(GREY_STORE);
  const today = ukDate();
  const from = addDays(today, -days);
  const listed = await store.list();
  const keys = (listed.blobs || [])
    .map((b) => b.key)
    .filter((k) => k.startsWith('day:') && k.replace('day:', '') >= from)
    .sort();

  const blobs = await Promise.all(
    keys.map(async (k) => { try { return await store.get(k, { type: 'json' }); } catch { return null; } })
  );

  const tips = [];
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
      tips.push({ date: d.date, name: t.dog, result, profit });
    }
  }
  return tips.sort((a, b) => a.date.localeCompare(b.date));
}

async function recentHorseTips(days = 21) {
  try {
    const all = await getStore(TIPS_STORE).get('days', { type: 'json' });
    if (!all) return [];
    const from = addDays(ukDate(), -days);
    const out = [];
    for (const [date, day] of Object.entries(all)) {
      if (date < from) continue;
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
        out.push({ date, name: t.horse, result, profit });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

async function readWhop() {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), 4000);
  try {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
    const res = await fetch(
      `${base}/.netlify/functions/hnh-whop?pw=${encodeURIComponent(process.env.ADMIN_PASSWORD)}`,
      { signal: c.signal }
    );
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

async function readEvents(days = 14) {
  const store = getStore(EVENTS_STORE);
  const today = ukDate();
  const dates = [];
  let cur = addDays(today, -days);
  while (cur <= today) { dates.push(cur); cur = addDays(cur, 1); }
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

// --- checks ----------------------------------------------------------------

function losingRun(tips) {
  const settled = tips.filter((t) => t.profit !== null && t.result !== 'pending');
  let run = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    if (settled[i].result === 'lose') run++;
    else break;
  }
  return run;
}

function drawdown(tips, days = 14) {
  const from = addDays(ukDate(), -days);
  return round2(
    tips
      .filter((t) => t.date >= from && t.profit !== null)
      .reduce((a, t) => a + t.profit, 0)
  );
}

export default async (req) => {
  const url = new URL(req.url || 'https://x/');
  const forced = url.searchParams.get('force') === '1';
  if (forced && url.searchParams.get('pw') !== process.env.ADMIN_PASSWORD) {
    return new Response('unauthorised', { status: 401 });
  }

  try {
    const store = getStore(EVENTS_STORE);
    let state = {};
    try { state = (await store.get(STATE_KEY, { type: 'json' })) || {}; } catch { /* first run */ }

    const [trap, horses, whop, events] = await Promise.all([
      recentTrapTips(21), recentHorseTips(21), readWhop(), readEvents(14),
    ]);

    const alerts = [];
    const nextState = { ...state, lastRun: new Date().toISOString() };

    // 1. Losing runs. Members get twitchy well before you do.
    for (const [label, tips] of [['free trap', trap], ['horses', horses]]) {
      const run = losingRun(tips);
      const key = `run_${label.replace(/\s/g, '')}`;
      nextState[key] = run;
      if (run >= LOSING_RUN_ALERT && run > (state[key] || 0)) {
        alerts.push(
          `<b>${esc(label)}: ${run} losers in a row.</b> Worth getting ahead of it - a short note about variance lands better before people start asking than after.`
        );
      }
    }

    // 2. Rolling drawdown.
    for (const [label, tips] of [['Free trap', trap], ['Horses', horses]]) {
      const dd = drawdown(tips, 14);
      const key = `dd_${label.replace(/\s/g, '')}`;
      const prev = state[key];
      nextState[key] = dd;
      if (dd <= DRAWDOWN_ALERT_PTS && (prev == null || dd < prev - 2)) {
        alerts.push(`<b>${esc(label)} down ${dd} pts over 14 days.</b> Deep enough that subscribers will have noticed.`);
      }
    }

    // 3. Platforms going quiet.
    const published = events.filter((e) => e.type === 'content.published');
    const lastByPlatform = {};
    for (const e of published) {
      const p = (e.payload && e.payload.platform) || 'unknown';
      const d = e.ts.slice(0, 10);
      if (!lastByPlatform[p] || d > lastByPlatform[p]) lastByPlatform[p] = d;
    }
    if (!published.length) {
      if (!state.quietFlagged) {
        alerts.push('<b>Nothing logged as published in 14 days.</b> Either content has stopped or it is not being logged - both worth fixing.');
        nextState.quietFlagged = true;
      }
    } else {
      nextState.quietFlagged = false;
      for (const [p, last] of Object.entries(lastByPlatform)) {
        const gap = Math.round((new Date(ukDate()) - new Date(last)) / 86400000);
        if (gap >= QUIET_PLATFORM_DAYS && state[`quiet_${p}`] !== last) {
          alerts.push(`<b>${esc(p)} has been quiet ${gap} days.</b> Follower-first algorithms read a gap as abandonment.`);
          nextState[`quiet_${p}`] = last;
        }
      }
    }

    // 4. Revenue movement.
    if (whop && whop.mrr != null) {
      const prev = state.mrr;
      nextState.mrr = whop.mrr;
      nextState.activeMembers = whop.activeMembers;
      if (prev != null && Math.abs(whop.mrr - prev) >= MRR_CHANGE_ALERT) {
        const dir = whop.mrr > prev ? 'up' : 'down';
        alerts.push(
          `<b>MRR ${dir} £${round2(Math.abs(whop.mrr - prev))} to £${whop.mrr}.</b> ${whop.activeMembers} active${whop.cancellingAtPeriodEnd ? `, ${whop.cancellingAtPeriodEnd} cancelling` : ''}.`
        );
      }

      // A cancellation shortly after a bad run is the pattern worth catching.
      const trapDd = drawdown(trap, 14);
      if (whop.cancellingAtPeriodEnd > (state.cancelling || 0) && trapDd < 0) {
        alerts.push(
          `<b>Someone cancelled during a losing spell</b> (${trapDd} pts over 14 days). Not proof of a link, but worth watching whether churn tracks results.`
        );
      }
      nextState.cancelling = whop.cancellingAtPeriodEnd;
    }

    // 5. Unsettled tips - a stale record is worse than no record.
    const stalePending = horses.filter(
      (h) => h.result === 'pending' && h.date < addDays(ukDate(), -1)
    ).length;
    if (stalePending >= 3 && stalePending !== state.stalePending) {
      alerts.push(`<b>${stalePending} horse tips still unsettled</b> from before yesterday. The published record is drifting out of date.`);
    }
    nextState.stalePending = stalePending;

    await store.setJSON(STATE_KEY, nextState);

    if (!alerts.length) return new Response('nothing to report', { status: 200 });

    const chatId = process.env.BRIEF_CHAT_ID;
    if (!chatId) throw new Error('BRIEF_CHAT_ID is not set');

    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: ['<b>Worth knowing</b>', '', ...alerts.map((a) => `• ${a}`)].join('\n'),
      disable_web_page_preview: true,
    });

    return new Response(`sent ${alerts.length} alert(s)`, { status: 200 });
  } catch (err) {
    console.error('alerts failed:', err);
    return new Response(`alerts failed: ${err.message}`, { status: 500 });
  }
};

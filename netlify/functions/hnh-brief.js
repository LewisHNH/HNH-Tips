// netlify/functions/hnh-brief.js
//
// SELF-CONTAINED. No folders, no imports from other files of mine.
// Goes at:  netlify/functions/hnh-brief.js
//
// Manual test:
//   /.netlify/functions/hnh-brief?force=1&pw=YOUR_ADMIN_PASSWORD

// ===========================================================================
// ==  EDIT THIS SECTION. Everything below it is machinery.                 ==
// ===========================================================================

// Big meetings. Inclusive date ranges. Add rows as the calendar fills.
const FIXTURES = [
  { name: 'Ebor Festival', from: '2026-08-19', to: '2026-08-22', sport: 'horses' },
  // { name: 'Cheltenham Festival', from: '2027-03-16', to: '2027-03-19', sport: 'horses' },
];

// Rules decide what the brief tells you to film and when to post it.
// ctx = { date, dow, fixture, bigWinners }   dow: 0=Sun ... 6=Sat
const RULES = [
  {
    id: 'fixture-preview',
    match: (ctx) => !!ctx.fixture,
    tasks: (ctx) => [{
      title: `${ctx.fixture.name} preview - 60s vertical`,
      ref: `${ctx.fixture.name.toLowerCase().replace(/\s+/g, '-')}-${ctx.date}`,
      platform: 'tiktok',
      filmBy: '11:00',
      postAt: '12:30',
      note: 'Analysis framing. No odds as a call to action, no bet slips.',
    }],
  },
  {
    id: 'saturday-card',
    match: (ctx) => ctx.dow === 6 && !ctx.fixture,
    tasks: (ctx) => [{
      title: 'Saturday card walkthrough',
      ref: `sat-card-${ctx.date}`,
      platform: 'tiktok',
      filmBy: '10:30',
      postAt: '12:30',
      note: 'Two races max. Reasoning over selections.',
    }],
  },
  {
    id: 'big-winner-clip',
    match: (ctx) => ctx.bigWinners.length > 0,
    tasks: (ctx) => [{
      title: `Result clip - ${ctx.bigWinners[0].selection} (${ctx.bigWinners[0].advisedPrice})`,
      ref: `winner-${ctx.date}`,
      platform: 'instagram',
      filmBy: '17:00',
      postAt: '19:00',
      note: 'Advised price vs SP is the story. Not the profit figure.',
    }],
  },
  {
    id: 'sunday-review',
    match: (ctx) => ctx.dow === 0,
    tasks: (ctx) => [{
      title: 'Weekly P&L card - both codes',
      ref: `weekly-pl-${ctx.date}`,
      platform: 'x',
      filmBy: null,
      postAt: '20:00',
      note: 'Check the numbers before it goes.',
    }],
  },
  {
    id: 'greyhound-daily',
    match: () => true,
    tasks: (ctx) => [{
      title: 'Greyhound tips to Exclusive Group',
      ref: `grey-tips-${ctx.date}`,
      platform: 'telegram',
      filmBy: null,
      postAt: '18:40',
      note: 'Judges in by 18:00.',
    }],
  },
];

// ===========================================================================
// ==  MACHINERY. You shouldn't need to touch anything past here.          ==
// ===========================================================================

const STORE_NAME = 'hnh-events';

async function getEventStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore(STORE_NAME);
}

// UK dates, not UTC dates. Matters for a 6:45am brief.
function ukDate(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(dt);
}

function ukHour(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return parseInt(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', hour12: false,
  }).format(dt), 10);
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

async function appendEvent(event) {
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

// --- maths: every number is computed here, never generated -----------------

function toDecimal(price) {
  if (price == null) return null;
  if (typeof price === 'number') return price;
  const s = String(price).trim().toLowerCase();
  if (s === 'evens' || s === 'evs' || s === '1/1') return 2;
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    if (!isFinite(n) || !isFinite(d) || d === 0) return null;
    return n / d + 1;
  }
  const num = Number(s);
  return isFinite(num) ? num : null;
}

function betProfit({ result, stake, price, placedFraction = 0.25 }) {
  const s = Number(stake) || 0;
  const p = toDecimal(price);
  if (!s || !p) return 0;
  if (result === 'win') return s * (p - 1);
  if (result === 'placed') return s * ((p - 1) * placedFraction) - s * (1 - placedFraction);
  if (result === 'void') return 0;
  return -s;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function tipMetrics(events, filter = {}) {
  const settled = events.filter((e) => {
    if (e.type !== 'tip.settled') return false;
    if (filter.sport && e.sport !== filter.sport) return false;
    return true;
  });

  let staked = 0, profitAdvised = 0, profitSP = 0, wins = 0, voids = 0, spKnown = 0;

  for (const e of settled) {
    const { stake, advisedPrice, sp, result } = e.payload;
    const s = Number(stake) || 0;
    if (result === 'void') { voids++; continue; }
    staked += s;
    if (result === 'win') wins++;
    profitAdvised += betProfit({ result, stake: s, price: advisedPrice });
    if (sp != null && toDecimal(sp) != null) {
      spKnown += s;
      profitSP += betProfit({ result, stake: s, price: sp });
    }
  }

  const runners = settled.length - voids;
  return {
    bets: runners,
    wins,
    voids,
    strikeRate: runners ? round2((wins / runners) * 100) : 0,
    staked: round2(staked),
    profit: round2(profitAdvised),
    roi: staked ? round2((profitAdvised / staked) * 100) : 0,
    profitSP: spKnown ? round2(profitSP) : null,
    advisedVsSpGap: spKnown ? round2(profitAdvised - profitSP) : null,
  };
}

function memberMetrics(events) {
  const c = (t) => events.filter((e) => e.type === t).length;
  const joined = c('member.joined'), left = c('member.left');
  const subsStarted = c('sub.started'), subsCancelled = c('sub.cancelled');
  return {
    netMembers: joined - left,
    netSubs: subsStarted - subsCancelled,
  };
}

function contentPipeline(events, now = new Date()) {
  const byRef = new Map();
  for (const e of events) {
    if (!e.type || !e.type.startsWith('content.')) continue;
    const ref = e.payload && e.payload.ref;
    if (!ref) continue;
    if (!byRef.has(ref)) {
      byRef.set(ref, { ref, planned: null, filmed: null, published: null, title: ref });
    }
    const item = byRef.get(ref);
    item[e.type.split('.')[1]] = e.ts;
    if (e.payload.title) item.title = e.payload.title;
  }
  const items = [...byRef.values()];
  const hrs = (ts) => (now - new Date(ts)) / 36e5;
  return {
    unfilmed: items.filter((i) => i.planned && !i.filmed),
    stale: items.filter((i) => i.filmed && !i.published && hrs(i.filmed) > 48),
  };
}

// --- rules -----------------------------------------------------------------

function fixtureFor(date) {
  return FIXTURES.find((f) => date >= f.from && date <= f.to) || null;
}

function tasksForDate(date, dow, bigWinners) {
  const ctx = { date, dow, fixture: fixtureFor(date), bigWinners };
  const out = [];
  for (const rule of RULES) {
    try {
      if (rule.match(ctx)) out.push(...rule.tasks(ctx));
    } catch (err) {
      out.push({ title: `RULE ERROR: ${rule.id} - ${err.message}` });
    }
  }
  return out.sort((a, b) => (a.postAt || '99:99').localeCompare(b.postAt || '99:99'));
}

// --- telegram --------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendMessage(chatId, text) {
  const token = process.env.BRAIN_BOT_TOKEN;
  if (!token) throw new Error('BRAIN_BOT_TOKEN is not set');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram: ${data.description}`);
  return data.result;
}

// --- the brief -------------------------------------------------------------

function fmtPts(n) {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)} pts`;
}

function prettyDate(isoDate) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function sportLine(label, m) {
  if (!m.bets) return `${label}: no bets settled`;
  const gap = m.advisedVsSpGap != null
    ? ` (SP ${fmtPts(m.profitSP)}, gap ${fmtPts(m.advisedVsSpGap)})`
    : '';
  return `${label}: ${m.wins}/${m.bets} · ${m.strikeRate}% · ${fmtPts(m.profit)}${gap}`;
}

async function buildBrief() {
  const today = ukDate();
  const yesterday = addDays(today, -1);
  const monthStart = `${today.slice(0, 7)}-01`;

  const yEvents = await readDay(yesterday);
  const monthEvents = await readRange(monthStart, yesterday);
  const recent = await readRange(addDays(today, -13), today);

  const yH = tipMetrics(yEvents, { sport: 'horses' });
  const yG = tipMetrics(yEvents, { sport: 'greyhounds' });
  const mH = tipMetrics(monthEvents, { sport: 'horses' });
  const mG = tipMetrics(monthEvents, { sport: 'greyhounds' });
  const members = memberMetrics(monthEvents);
  const pipe = contentPipeline(recent);

  const bigWinners = yEvents
    .filter((e) => e.type === 'tip.settled' && e.payload.result === 'win')
    .filter((e) => (toDecimal(e.payload.advisedPrice) || 0) >= 9)
    .map((e) => e.payload);

  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const tasks = tasksForDate(today, dow, bigWinners);
  const fixture = fixtureFor(today);

  const L = [];
  L.push(`<b>HNH BRIEF — ${esc(prettyDate(today))}</b>`);
  if (fixture) L.push(`<i>${esc(fixture.name)}</i>`);
  L.push('');

  L.push('<b>Yesterday</b>');
  L.push(esc(sportLine('Horses', yH)));
  L.push(esc(sportLine('Greys', yG)));
  L.push('');

  L.push('<b>Month to date</b>');
  L.push(esc(`Horses ${fmtPts(mH.profit)} · ROI ${mH.roi}%`));
  L.push(esc(`Greys  ${fmtPts(mG.profit)} · ROI ${mG.roi}%`));
  if (mG.advisedVsSpGap != null) {
    L.push(esc(`Advised beat SP by ${fmtPts(mG.advisedVsSpGap)} on greys`));
  }
  L.push(esc(`Subs ${members.netSubs >= 0 ? '+' : ''}${members.netSubs} · members ${members.netMembers >= 0 ? '+' : ''}${members.netMembers}`));
  L.push('');

  L.push('<b>Today</b>');
  if (!tasks.length) {
    L.push('Nothing scheduled.');
  } else {
    for (const t of tasks) {
      const when = t.postAt || 'anytime';
      const film = t.filmBy ? ` · film by ${t.filmBy}` : '';
      L.push(esc(`${when} ${t.platform || ''} — ${t.title}${film}`));
      if (t.note) L.push(`  <i>${esc(t.note)}</i>`);
    }
  }

  const nags = [];
  if (pipe.unfilmed.length) nags.push(`${pipe.unfilmed.length} planned, not filmed`);
  if (pipe.stale.length) nags.push(`"${pipe.stale[0].title}" filmed but unposted 48h+`);
  if (!yH.bets && !yG.bets) nags.push('No results logged yesterday — settle them');

  if (nags.length) {
    L.push('');
    L.push('<b>Chasing you</b>');
    for (const n of nags.slice(0, 3)) L.push(esc(`• ${n}`));
  }

  return L.join('\n');
}

exports.handler = async (req) => {
  const q = (req && req.queryStringParameters) || {};
  const forced = q.force === '1';

  if (forced && q.pw !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: 'unauthorised' };
  }

  // Cron runs at 05:45 and 06:45 UTC; only one of those is 06:45 UK.
  // This guard means it survives the clock change without editing.
  if (!forced && ukHour() !== 6) {
    return { statusCode: 200, body: 'skipped: not 6am UK' };
  }

  try {
    const chatId = process.env.BRIEF_CHAT_ID;
    if (!chatId) throw new Error('BRIEF_CHAT_ID is not set');
    const text = await buildBrief();
    await sendMessage(chatId, text);
    await appendEvent({ type: 'brief.generated', payload: { chars: text.length } });
    return { statusCode: 200, body: 'sent' };
  } catch (err) {
    console.error('brief failed:', err);
    return { statusCode: 500, body: `brief failed: ${err.message}` };
  }
};

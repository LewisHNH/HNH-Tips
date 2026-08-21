// netlify/functions/hnh-webhook.js
//
// Two-way Telegram brain. Telegram POSTs every message you send the bot
// to this function. Locked to your user ID only.
//
// ONE-TIME REGISTRATION (paste in browser, real token):
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tips.hoovesnhounds.com/.netlify/functions/hnh-webhook
//
// To check it later:   .../bot<TOKEN>/getWebhookInfo
// To turn it off:      .../bot<TOKEN>/deleteWebhook

import { getStore } from '@netlify/blobs';

// Change this if you want a cheaper/faster model. Haiku is fine for
// most questions; Sonnet reads the numbers more carefully.
const MODEL = 'claude-sonnet-5';

const STORE_NAME = 'hnh-events';

// ---------------------------------------------------------------------------
// Store helpers (same shape as hnh-brief.js - kept local so this file
// stands alone and can't break from a folder problem)
// ---------------------------------------------------------------------------

const store = () => getStore(STORE_NAME);

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
  const raw = await store().get(`day/${isoDate}`, { type: 'json' });
  return Array.isArray(raw) ? raw : [];
}

async function readRange(from, to) {
  const out = [];
  let cursor = from, guard = 0;
  while (cursor <= to && guard < 400) {
    out.push(...(await readDay(cursor)));
    cursor = addDays(cursor, 1);
    guard++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Maths. Claude never calculates - it only reads these results.
// ---------------------------------------------------------------------------

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

function betProfit({ result, stake, price }) {
  const s = Number(stake) || 0;
  const p = toDecimal(price);
  if (!s || !p) return 0;
  if (result === 'win') return s * (p - 1);
  if (result === 'void') return 0;
  return -s;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function tipMetrics(events, sport) {
  const settled = events.filter(
    (e) => e.type === 'tip.settled' && (!sport || e.sport === sport)
  );
  let staked = 0, pAdv = 0, pSP = 0, wins = 0, voids = 0, spStaked = 0;

  for (const e of settled) {
    const { stake, advisedPrice, sp, result } = e.payload;
    const s = Number(stake) || 0;
    if (result === 'void') { voids++; continue; }
    staked += s;
    if (result === 'win') wins++;
    pAdv += betProfit({ result, stake: s, price: advisedPrice });
    if (sp != null && toDecimal(sp) != null) {
      spStaked += s;
      pSP += betProfit({ result, stake: s, price: sp });
    }
  }

  const bets = settled.length - voids;
  return {
    bets,
    wins,
    strikeRate: bets ? round2((wins / bets) * 100) : 0,
    staked: round2(staked),
    profitPts: round2(pAdv),
    roiPct: staked ? round2((pAdv / staked) * 100) : 0,
    profitAtSP: spStaked ? round2(pSP) : null,
    advisedVsSpGap: spStaked ? round2(pAdv - pSP) : null,
  };
}

function contentPipeline(events, now = new Date()) {
  const byRef = new Map();
  for (const e of events) {
    if (!e.type || !e.type.startsWith('content.')) continue;
    const ref = e.payload && e.payload.ref;
    if (!ref) continue;
    if (!byRef.has(ref)) byRef.set(ref, { ref, title: ref, planned: null, filmed: null, published: null });
    const it = byRef.get(ref);
    it[e.type.split('.')[1]] = e.ts;
    if (e.payload.title) it.title = e.payload.title;
  }
  const items = [...byRef.values()];
  const hrs = (ts) => (now - new Date(ts)) / 36e5;
  return {
    unfilmed: items.filter((i) => i.planned && !i.filmed).map((i) => i.title),
    unposted48h: items.filter((i) => i.filmed && !i.published && hrs(i.filmed) > 48).map((i) => i.title),
    publishedLast14d: items.filter((i) => i.published).length,
  };
}

/**
 * Build the full picture in one pass. Everything Claude might need,
 * pre-computed, so it never has to do arithmetic.
 */
async function buildContext() {
  const today = ukDate();
  const last60 = await readRange(addDays(today, -59), today);

  const since = (n) => {
    const cutoff = addDays(today, -n);
    return last60.filter((e) => ukDate(e.ts) >= cutoff);
  };

  const window = (evts) => ({
    horses: tipMetrics(evts, 'horses'),
    greyhounds: tipMetrics(evts, 'greyhounds'),
    combined: tipMetrics(evts, null),
  });

  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEvents = last60.filter((e) => ukDate(e.ts) >= monthStart);

  const count = (evts, t) => evts.filter((e) => e.type === t).length;
  const m30 = since(30);

  return {
    today,
    yesterday: window(last60.filter((e) => ukDate(e.ts) === addDays(today, -1))),
    last7Days: window(since(7)),
    last30Days: window(since(30)),
    monthToDate: window(monthEvents),
    membership: {
      last30Days: {
        joined: count(m30, 'member.joined'),
        left: count(m30, 'member.left'),
        subsStarted: count(m30, 'sub.started'),
        subsCancelled: count(m30, 'sub.cancelled'),
      },
    },
    content: contentPipeline(since(14)),
    totalEventsOnRecord: last60.length,
  };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function tg(method, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.BRAIN_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  return res.json();
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// The brain
// ---------------------------------------------------------------------------

const SYSTEM = `You are the private admin brain for Hooves & Hounds (HNH), a UK horse racing and greyhound tipping service run by Lewis. You are talking to Lewis himself, nobody else.

You will be given a JSON block of pre-computed business figures. Rules about it:
- Every number you state must come from that JSON. Never calculate, estimate, or infer a figure that isn't there.
- If the answer isn't in the data, say so plainly and say what would need logging to answer it.
- Points are the staking unit. "Advised vs SP gap" means how much better the advised price performed than starting price — HNH's strongest verifiable claim.
- Zeroes usually mean nothing has been logged yet, not that performance was flat. Say which it is if unclear.

Style: you're talking to someone on a phone. Two or three sentences usually. No headers, no bullet lists unless genuinely comparing several things. Direct, plain UK English. No preamble.

You do not give betting tips, selections, or predictions — that's Lewis's job, not yours. If asked, say so.`;

async function askClaude(question, context) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Business figures:\n\`\`\`json\n${JSON.stringify(context, null, 1)}\n\`\`\`\n\nQuestion: ${question}`,
      }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'anthropic error');
  return (data.content || [])
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async (req) => {
  // Always 200 to Telegram, whatever happens. A non-200 makes Telegram
  // retry the same update, which is how you end up with double replies.
  const ok = () => new Response('ok', { status: 200 });

  let update;
  try {
    update = await req.json();
  } catch {
    return ok();
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return ok();

  const fromId = String(msg.from && msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // --- whitelist ---------------------------------------------------------
  const owner = process.env.OWNER_TELEGRAM_ID;
  if (!owner) {
    // Bootstrap: not configured yet, so tell Lewis his own ID once.
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Not configured yet. Set OWNER_TELEGRAM_ID in Netlify to:\n\n${fromId}\n\nThen redeploy.`,
    });
    return ok();
  }
  if (fromId !== String(owner)) {
    console.log(`rejected message from ${fromId}`);
    return ok(); // silent - don't confirm the bot exists
  }

  // --- duplicate guard ---------------------------------------------------
  // Telegram retries on slow responses. Without this you get the same
  // answer two or three times.
  const seenKey = `seen/${update.update_id}`;
  try {
    const seen = await store().get(seenKey);
    if (seen) return ok();
    await store().set(seenKey, '1');
  } catch (err) {
    console.error('dedupe check failed:', err);
  }

  // --- commands ----------------------------------------------------------
  if (text === '/start' || text === '/help') {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: [
        '<b>HNH Brain</b>',
        '',
        'Ask me anything about the business. For example:',
        '• How did greyhounds do last week?',
        '• What is the advised vs SP gap this month?',
        '• What have I not filmed?',
        '• Are subs growing?',
        '',
        '/brief — send today\'s morning brief now',
      ].join('\n'),
    });
    return ok();
  }

  if (text === '/brief') {
    try {
      const res = await fetch(
        `${process.env.URL}/.netlify/functions/hnh-brief?pw=${encodeURIComponent(process.env.ADMIN_PASSWORD)}`
      );
      const body = await res.text();
      if (body !== 'sent') {
        await tg('sendMessage', { chat_id: chatId, text: `Brief failed: ${body}` });
      }
    } catch (err) {
      await tg('sendMessage', { chat_id: chatId, text: `Brief failed: ${err.message}` });
    }
    return ok();
  }

  // --- question ----------------------------------------------------------
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    const context = await buildContext();
    const answer = await askClaude(text, context);
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: esc(answer),
    });
  } catch (err) {
    console.error('brain failed:', err);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Couldn't answer that: ${err.message}`,
    });
  }

  return ok();
};

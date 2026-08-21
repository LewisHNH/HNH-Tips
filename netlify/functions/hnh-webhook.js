// netlify/functions/hnh-webhook.js
//
// Two-way Telegram brain, reading ALL historical data:
//   - hnh-greyhounds  month: aggregates (complete group record)
//   - hnh-tips        per-bet horse tips (from 17 Aug 2026)
//   - HORSE_ARCHIVE   carried-over monthly totals (Apr - 18 Aug 2026)
//   - hnh-events      content pipeline and anything logged manually
//
// Locked to OWNER_TELEGRAM_ID.
//
// Register once:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tips.hoovesnhounds.com/.netlify/functions/hnh-webhook

import { getStore } from '@netlify/blobs';

const MODEL = 'claude-sonnet-5';

// ===========================================================================
// ==  HORSE ARCHIVE - carried over from the published record.              ==
// ==  Aggregates only. No per-bet detail exists for these months.          ==
// ===========================================================================

const HORSE_ARCHIVE = [
  { month: '2026-04', points: 57.6, roiPct: 43.7 },
  { month: '2026-05', points: 40.9, roiPct: 11.1 },
  { month: '2026-06', points: -3.5, roiPct: -1.1 },
  { month: '2026-07', points: 28.9, roiPct: 17.8 },
  { month: '2026-08', points: -24.7, roiPct: -22.7 }, // through 18 Aug only
];

// The published archive covers up to and including this date. Per-bet tips
// on or before it are already inside HORSE_ARCHIVE, so they're excluded from
// live totals to stop August being counted twice.
const ARCHIVE_THROUGH = '2026-08-18';

// ===========================================================================
// ==  Machinery                                                            ==
// ===========================================================================

const EVENTS_STORE = 'hnh-events';
const GREY_STORE = 'hnh-greyhounds';
const TIPS_STORE = 'hnh-tips';

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

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// --- odds ------------------------------------------------------------------

function toDecimal(price) {
  if (price == null || price === '') return null;
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

function placeFraction(terms) {
  if (!terms) return 0.2;
  const s = String(terms).trim();
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    if (isFinite(n) && isFinite(d) && d !== 0) return n / d;
  }
  return 0.2;
}

// Result strings vary. Match defensively rather than assume one spelling.
function normaliseResult(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || s === 'pending' || s === 'tbc') return 'pending';
  if (['won', 'win', 'winner', 'w'].includes(s)) return 'win';
  if (['lost', 'lose', 'loser', 'l', 'unplaced'].includes(s)) return 'lose';
  if (['placed', 'place', 'p'].includes(s)) return 'placed';
  if (['void', 'nr', 'non-runner', 'nonrunner', 'withdrawn'].includes(s)) return 'void';
  return 'unknown';
}

/**
 * Profit in points for one horse tip.
 *
 * Each-way: 1pt EW = 2pt total outlay (1 win + 1 place).
 *   win    -> stake*(dec-1) on the win part, plus stake*((dec-1)*frac) on the place
 *   placed -> win part loses the stake, place part pays
 *   lose   -> both parts lost, so -2 * stake
 */
function horseProfit(tip) {
  // A manual override always wins. That's what the field is for.
  const mp = tip.manualPts;
  if (mp !== undefined && mp !== null && String(mp).trim() !== '') {
    const m = Number(mp);
    if (isFinite(m)) return m;
  }

  const result = normaliseResult(tip.result);
  if (result === 'pending' || result === 'unknown') return null;

  const stake = Number(tip.stake) || 0;
  const dec = toDecimal(tip.price);
  if (!stake || !dec) return null;

  if (result === 'void') return 0;

  const isEW = String(tip.betType || '').trim().toLowerCase() === 'ew';
  const frac = placeFraction(tip.placeTerms);

  if (!isEW) {
    if (result === 'win') return stake * (dec - 1);
    return -stake; // a place pays nothing on a win-only bet
  }

  const winPart = result === 'win' ? stake * (dec - 1) : -stake;
  const placePart =
    result === 'win' || result === 'placed' ? stake * ((dec - 1) * frac) : -stake;
  return winPart + placePart;
}

function horseOutlay(tip) {
  const stake = Number(tip.stake) || 0;
  const isEW = String(tip.betType || '').trim().toLowerCase() === 'ew';
  return isEW ? stake * 2 : stake;
}

// --- readers ---------------------------------------------------------------

/**
 * Free Trap of the Day. Lives in the day: records - one selection per day,
 * with `points` as the stake and oddsAdvised as the price.
 *
 * The `removed` array on each day is the tamper-evident audit trail from the
 * 15-minute deletion window. Surfaced so the record can be defended, never
 * netted off the P&L.
 */
async function readTrapOfTheDay() {
  try {
    const store = getStore(GREY_STORE);
    const listed = await store.list();
    const dayKeys = (listed.blobs || [])
      .map((b) => b.key)
      .filter((k) => k.startsWith('day:'))
      .sort();

    const tips = [];
    let removedCount = 0;

    for (const k of dayKeys) {
      const v = await store.get(k, { type: 'json' });
      if (!v) continue;
      removedCount += (v.removed || []).length;

      for (const t of v.tips || []) {
        const stake = Number(t.points) || 0;
        const dec = toDecimal(t.oddsAdvised);
        const result = normaliseResult(t.result);

        let profit = null;
        if (result === 'win' && stake && dec) profit = stake * (dec - 1);
        else if (result === 'lose' && stake) profit = -stake;
        else if (result === 'void') profit = 0;

        // SP is often blank on these, so the advised-vs-SP gap can only be
        // computed for the ones where it was recorded.
        const spDec = toDecimal(t.oddsSP);
        let profitAtSP = null;
        if (spDec && stake) {
          if (result === 'win') profitAtSP = stake * (spDec - 1);
          else if (result === 'lose') profitAtSP = -stake;
          else if (result === 'void') profitAtSP = 0;
        }

        tips.push({
          date: v.date || k.replace('day:', ''),
          time: t.time,
          track: (t.track || '').trim(),
          trap: t.trap,
          dog: (t.dog || '').trim(),
          oddsAdvised: t.oddsAdvised,
          oddsSP: t.oddsSP || null,
          stakePts: stake,
          result,
          profitPts: profit === null ? null : round2(profit),
          profitAtSPPts: profitAtSP === null ? null : round2(profitAtSP),
          tipster: t.tipster,
        });
      }
    }

    tips.sort((a, b) => (a.date < b.date ? -1 : 1));

    const settled = tips.filter((t) => t.profitPts !== null);
    const staked = settled.reduce((a, t) => a + t.stakePts, 0);
    const profit = settled.reduce((a, t) => a + t.profitPts, 0);
    const wins = settled.filter((t) => t.result === 'win').length;

    // Only the subset where SP was actually recorded.
    const withSP = settled.filter((t) => t.profitAtSPPts !== null);
    const spProfit = withSP.reduce((a, t) => a + t.profitPts, 0);
    const spAtSP = withSP.reduce((a, t) => a + t.profitAtSPPts, 0);

    return {
      tips,
      totals: {
        bets: settled.length,
        wins,
        pending: tips.filter((t) => t.result === 'pending').length,
        stakedPts: round2(staked),
        profitPts: round2(profit),
        roiPct: staked ? round2((profit / staked) * 100) : null,
        strikeRatePct: settled.length ? round2((wins / settled.length) * 100) : null,
      },
      advisedVsSP: withSP.length
        ? {
            betsWithSPRecorded: withSP.length,
            profitAtAdvisedPts: round2(spProfit),
            profitAtSPPts: round2(spAtSP),
            gapPts: round2(spProfit - spAtSP),
          }
        : { betsWithSPRecorded: 0, note: 'SP not recorded on these yet, so the advised-vs-SP gap cannot be calculated for the free trap.' },
      auditTrail: {
        removedEntries: removedCount,
        note: 'Selections deleted inside the 15-minute window. Kept as tamper-evident proof, never netted off the P&L.',
      },
    };
  } catch (err) {
    console.error('trap of the day read failed:', err);
    return null;
  }
}

/**
 * Two separate greyhound records, and they must never be conflated:
 *   month:      -> paid Exclusive Group (Whop)
 *   day:        -> free Trap of the Day (public, on the site)
 * Quoting the paid record as if it were the free one would be a
 * misleading claim, so they stay apart all the way through.
 */
async function readGreyhoundMonths(prefix) {
  try {
    const store = getStore(GREY_STORE);
    const listed = await store.list();
    const monthKeys = (listed.blobs || [])
      .map((b) => b.key)
      // startsWith('month:') would not match 'freemonth:', but be explicit
      // rather than rely on that.
      .filter((k) => k.startsWith(prefix))
      .sort();

    const months = [];
    for (const k of monthKeys) {
      const v = await store.get(k, { type: 'json' });
      if (!v) continue;
      const staked = Number(v.staked) || 0;
      const points = Number(v.points) || 0;
      const tips = Number(v.tips) || 0;
      const winners = Number(v.winners) || 0;
      months.push({
        month: v.month || k.slice(prefix.length),
        kind: v.kind || 'group',
        tips,
        winners,
        stakedPts: round2(staked),
        profitPts: round2(points),
        roiPct: staked ? round2((points / staked) * 100) : null,
        strikeRatePct: tips ? round2((winners / tips) * 100) : null,
      });
    }
    return months;
  } catch (err) {
    console.error('greyhound read failed:', err);
    return [];
  }
}

async function readHorseTips() {
  try {
    const store = getStore(TIPS_STORE);
    const days = await store.get('days', { type: 'json' });
    if (!days || typeof days !== 'object') return [];

    const out = [];
    for (const [date, day] of Object.entries(days)) {
      for (const t of day.tips || []) {
        out.push({
          date,
          tipster: t.tipster || 'unknown',
          course: (t.course || '').trim(),
          horse: (t.horse || '').trim(),
          price: t.price,
          sp: t.sp || null,
          stake: Number(t.stake) || 0,
          betType: t.betType || 'win',
          placeTerms: t.placeTerms || '1/5',
          result: normaliseResult(t.result),
          profitPts: horseProfit(t),
          outlayPts: horseOutlay(t),
          countedInArchive: date <= ARCHIVE_THROUGH,
        });
      }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch (err) {
    console.error('horse tips read failed:', err);
    return [];
  }
}

function summariseHorseTips(tips) {
  const settled = tips.filter((t) => t.profitPts !== null && t.result !== 'pending');
  let outlay = 0, profit = 0, wins = 0, places = 0;
  for (const t of settled) {
    outlay += t.outlayPts;
    profit += t.profitPts;
    if (t.result === 'win') wins++;
    if (t.result === 'placed') places++;
  }
  return {
    bets: settled.length,
    wins,
    places,
    pending: tips.filter((t) => t.result === 'pending').length,
    stakedPts: round2(outlay),
    profitPts: round2(profit),
    roiPct: outlay ? round2((profit / outlay) * 100) : null,
    strikeRatePct: settled.length ? round2((wins / settled.length) * 100) : null,
  };
}

function byTipster(tips) {
  const names = [...new Set(tips.map((t) => t.tipster))];
  const out = {};
  for (const n of names) out[n] = summariseHorseTips(tips.filter((t) => t.tipster === n));
  return out;
}

/**
 * Whop membership and revenue snapshot. Fetched over internal HTTP rather
 * than imported, so this file stays standalone. hnh-whop caches for 15
 * minutes, so this doesn't hammer Whop on every message.
 */
async function readWhop() {
  try {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
    const pw = process.env.ADMIN_PASSWORD;
    if (!base || !pw) return { error: 'site URL or admin password not configured' };

    const res = await fetch(
      `${base}/.netlify/functions/hnh-whop?pw=${encodeURIComponent(pw)}`
    );
    const data = await res.json();
    if (data.error) return { error: data.error };
    return data;
  } catch (err) {
    console.error('whop read failed:', err);
    return { error: err.message };
  }
}

async function readEventRange(from, to) {
  const store = getStore(EVENTS_STORE);
  const out = [];
  let cursor = from, guard = 0;
  while (cursor <= to && guard < 400) {
    try {
      const raw = await store.get(`day/${cursor}`, { type: 'json' });
      if (Array.isArray(raw)) out.push(...raw);
    } catch { /* a missing day is fine */ }
    cursor = addDays(cursor, 1);
    guard++;
  }
  return out;
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

// --- assemble --------------------------------------------------------------

async function buildContext() {
  const today = ukDate();

  const [paidMonths, trapFree, horseTips, recentEvents, whop] = await Promise.all([
    readGreyhoundMonths('month:'),
    readTrapOfTheDay(),
    readHorseTips(),
    readEventRange(addDays(today, -13), today),
    readWhop(),
  ]);

  const totals = (months) => {
    const t = months.reduce(
      (a, m) => ({
        tips: a.tips + m.tips,
        winners: a.winners + m.winners,
        staked: a.staked + m.stakedPts,
        points: a.points + m.profitPts,
      }),
      { tips: 0, winners: 0, staked: 0, points: 0 }
    );
    return {
      tips: t.tips,
      winners: t.winners,
      stakedPts: round2(t.staked),
      profitPts: round2(t.points),
      roiPct: t.staked ? round2((t.points / t.staked) * 100) : null,
      strikeRatePct: t.tips ? round2((t.winners / t.tips) * 100) : null,
    };
  };

  const liveHorseTips = horseTips.filter((t) => !t.countedInArchive);
  const archivePoints = HORSE_ARCHIVE.reduce((a, m) => a + m.points, 0);

  return {
    today,

    businessModel: {
      note: 'Three products. Only ONE is paid. The free output is the funnel; the Exclusive Group is the entire revenue line.',
      paid: ['Greyhound Exclusive Group (Whop)'],
      free: ['Greyhound Trap of the Day', 'Horse tips (Lewis and Nath)'],
    },

    greyhounds: {
      note: 'TWO SEPARATE RECORDS. Never combine them or quote one as the other.',

      exclusiveGroupPaid: {
        what: 'Paid Exclusive Group, sold on Whop. The only revenue-generating product.',
        months: paidMonths,
        allTime: totals(paidMonths),
      },

      trapOfTheDayFree: {
        what: 'Free Trap of the Day, published publicly on the site. One selection per day, separate record entirely.',
        allTime: trapFree ? trapFree.totals : null,
        advisedVsSP: trapFree ? trapFree.advisedVsSP : null,
        auditTrail: trapFree ? trapFree.auditTrail : null,
        recentTips: trapFree ? trapFree.tips.slice(-15) : [],
        dataPresent: !!(trapFree && trapFree.tips.length),
      },
    },

    horses: {
      what: 'FREE horse tips from Lewis and Nath. Not a paid product.',
      archive: {
        note: `Carried-over monthly totals, April 2026 to ${ARCHIVE_THROUGH}. Aggregates only - no per-bet detail exists, so these cannot be broken down by tipster, course or price.`,
        months: HORSE_ARCHIVE,
        totalProfitPts: round2(archivePoints),
      },
      live: {
        note: `Per-bet tips recorded on the site. Tips dated on or before ${ARCHIVE_THROUGH} are already inside the archive figures and are excluded here to avoid double counting.`,
        since: addDays(ARCHIVE_THROUGH, 1),
        summary: summariseHorseTips(liveHorseTips),
        byTipster: byTipster(liveHorseTips),
        recentTips: liveHorseTips.slice(-20).map((t) => ({
          date: t.date, tipster: t.tipster, course: t.course, horse: t.horse,
          price: t.price, sp: t.sp, stake: t.stake, betType: t.betType,
          result: t.result,
          profitPts: t.profitPts === null ? null : round2(t.profitPts),
        })),
      },
      everyRecordedTip: summariseHorseTips(horseTips),
    },

    revenue: {
      what: 'Whop subscription data for the paid Exclusive Group. The only revenue line in the business.',
      ...whop,
    },

    content: contentPipeline(recentEvents),
  };
}

// --- telegram --------------------------------------------------------------

async function tg(method, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.BRAIN_BOT_TOKEN}/${method}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return res.json();
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Claude replies in Markdown; Telegram wants HTML. Without this, **bold**
 * arrives as literal asterisks and the message looks like a mess.
 *
 * Escapes first, so no stray angle bracket in the text can break the markup.
 */
function mdToTelegramHtml(md) {
  let t = esc(md);

  // Fenced code blocks first, so their contents aren't touched below.
  const blocks = [];
  t = t.replace(/```[a-z]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(code.replace(/\n$/, ''));
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  // Inline code, protected the same way.
  const spans = [];
  t = t.replace(/`([^`\n]+)`/g, (_, code) => {
    spans.push(code);
    return `\u0000SPAN${spans.length - 1}\u0000`;
  });

  // Headings become bold lines - Telegram has no heading styles.
  t = t.replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>');

  // Bold before italic, or ** gets eaten by the single-asterisk rule.
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<i>$2</i>');
  t = t.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<i>$2</i>');

  // Markdown bullets to a real bullet character.
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');

  // Collapse runs of blank lines - they waste phone screen.
  t = t.replace(/\n{3,}/g, '\n\n');

  // Restore protected content.
  t = t.replace(/\u0000SPAN(\d+)\u0000/g, (_, i) => `<code>${spans[Number(i)]}</code>`);
  t = t.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => `<pre>${blocks[Number(i)]}</pre>`);

  return t.trim();
}

// --- brain -----------------------------------------------------------------

const SYSTEM = `You are the private admin brain for Hooves & Hounds (HNH), a UK horse racing and greyhound tipping service run by Lewis. You are talking to Lewis himself.

You get a JSON block of pre-computed figures. Rules:
- Every number you state must come from that JSON. Never calculate, estimate or infer a figure that isn't there.
- Horses have two tiers: an ARCHIVE of monthly aggregates (April to 18 Aug 2026, no per-bet detail) and LIVE per-bet tips after that. Don't add them together unless asked for an overall figure, and say clearly when you do.
- If asked something the archive can't answer (which tipster, which course, what price), say the per-bet detail doesn't exist for those months.
- There are TWO separate greyhound records and they must never be combined or confused: the paid Exclusive Group (sold on Whop) and the free Trap of the Day (published on the site). Always say which one a figure belongs to. Quoting the paid record as if it were the free one would be a misleading claim, so never do it, and flag it if Lewis seems about to.
- If trapOfTheDayFree.dataPresent is false, the free record isn't in the store yet - say so rather than falling back to the paid figures.
- Points are the staking unit. 1pt each-way means 2pt total outlay.
- "Advised vs SP gap" is how much better advised prices did than starting price - HNH's strongest verifiable claim.
- Zeroes usually mean nothing logged, not flat performance. Say which.

- Revenue comes only from the paid Exclusive Group on Whop. Monthly billing only, no annual or lifetime tier, so all revenue is re-decided every cycle and retention matters more than anything else.
- MRR is contracted revenue (active members x renewal price), not cash received. Say so if quoting it.
- The group has a hard place cap. Empty places are revenue already decided but not yet sold - worth pointing out when relevant.
- If revenue.error is present, the Whop data could not be read. Say so rather than guessing at figures.
- revenue.membersNeedingAction identifies members who are cancelling or have already lapsed, so Lewis can manage access to his own paid Telegram group. Name them freely when he asks who is cancelling or who to remove - that is the whole point of the list.
- Everyone else stays an anonymous count. Never invent a name or email for a member who is not on that list.
- When someone has lapsed, lead with the name and the date access ended, and say plainly they should be removed from the group. If telegramLinked is false, say he will need to match them by name or email.

FORMATTING - this is read on a phone, so it matters:
- Lead with the answer in one short sentence. No preamble, no restating the question.
- Default to plain prose. Two or three sentences answers most questions.
- Only use bullets when listing genuinely parallel items (several months, several members). Never bullet a single fact.
- Maximum 6 bullets. If there are more, summarise instead.
- Never use headings. Never bold a whole line. Bold at most one or two key figures.
- Put the number and its meaning in the same breath: "MRR is £559.84, which is contracted not cash" rather than a label-colon-value list.
- No trailing offers of further help unless you actually need a decision from Lewis.
- Round sensibly. £559.84 not £559.8400000001. Points to two decimals, percentages to one.

You do not give betting tips, selections or predictions. That's Lewis's job.`;

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
      max_tokens: 800,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Business figures:\n\`\`\`json\n${JSON.stringify(context)}\n\`\`\`\n\nQuestion: ${question}`,
      }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'anthropic error');
  return (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
}

// --- handler ---------------------------------------------------------------

export default async (req) => {
  const ok = () => new Response('ok', { status: 200 });

  let update;
  try { update = await req.json(); } catch { return ok(); }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return ok();

  const fromId = String(msg.from && msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const owner = process.env.OWNER_TELEGRAM_ID;
  if (!owner) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Not configured yet. Set OWNER_TELEGRAM_ID in Netlify to:\n\n${fromId}\n\nThen redeploy.`,
    });
    return ok();
  }
  if (fromId !== String(owner)) {
    console.log(`rejected message from ${fromId}`);
    return ok();
  }

  // Telegram retries slow webhooks. Without this you get double replies.
  const eventStore = getStore(EVENTS_STORE);
  const seenKey = `seen/${update.update_id}`;
  try {
    if (await eventStore.get(seenKey)) return ok();
    await eventStore.set(seenKey, '1');
  } catch (err) {
    console.error('dedupe failed:', err);
  }

  if (text === '/start' || text === '/help') {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: [
        '<b>HNH Brain</b>',
        '',
        'I can see the full greyhound group record, the carried-over horse archive back to April, and every per-bet horse tip since 17 Aug.',
        '',
        'Try:',
        '• Best and worst months this year?',
        '• How are Nath and I comparing?',
        '• What is the greyhound all-time ROI?',
        '• Which horse bets are still pending?',
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
      if (body !== 'sent') await tg('sendMessage', { chat_id: chatId, text: `Brief failed: ${body}` });
    } catch (err) {
      await tg('sendMessage', { chat_id: chatId, text: `Brief failed: ${err.message}` });
    }
    return ok();
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    const context = await buildContext();
    const answer = await askClaude(text, context);
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: mdToTelegramHtml(answer),
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('brain failed:', err);
    await tg('sendMessage', { chat_id: chatId, text: `Couldn't answer that: ${err.message}` });
  }

  return ok();
};

// netlify/functions/lib/metrics.js
// Every number that ever reaches a customer is computed here, in code.
// The LLM interprets these figures. It never produces them.

/**
 * Fractional odds string -> decimal. "12/1" -> 13, "5/2" -> 3.5, "evens" -> 2.
 * Passes through numbers unchanged.
 */
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

/**
 * Profit in points for a single settled bet.
 * result: 'win' | 'lose' | 'void' | 'placed'
 * placedFraction applies to each-way style part-returns if you ever use it.
 */
function betProfit({ result, stake, price, placedFraction = 0.25 }) {
  const s = Number(stake) || 0;
  const p = toDecimal(price);
  if (!s || !p) return 0;
  switch (result) {
    case 'win':
      return s * (p - 1);
    case 'placed':
      return s * ((p - 1) * placedFraction) - s * (1 - placedFraction);
    case 'void':
      return 0;
    case 'lose':
    default:
      return -s;
  }
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Core tipping metrics from a list of tip.settled events.
 *
 * Expected payload on tip.settled:
 *   { selection, tipster, advisedPrice, sp, stake, result, meeting }
 */
function tipMetrics(events, filter = {}) {
  const settled = events.filter((e) => {
    if (e.type !== 'tip.settled') return false;
    if (filter.sport && e.sport !== filter.sport) return false;
    if (filter.tipster && e.payload.tipster !== filter.tipster) return false;
    return true;
  });

  let staked = 0;
  let profitAdvised = 0;
  let profitSP = 0;
  let wins = 0;
  let voids = 0;
  let spKnown = 0;

  for (const e of settled) {
    const { stake, advisedPrice, sp, result } = e.payload;
    const s = Number(stake) || 0;

    if (result === 'void') {
      voids++;
      continue;
    }
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
    // The strongest verifiable claim you have. Positive = advised beat SP.
    advisedVsSpGap: spKnown ? round2(profitAdvised - profitSP) : null,
    spCoverage: settled.length ? round2((spKnown / (staked || 1)) * 100) : 0,
  };
}

/**
 * Membership movement across free channels and paid subs.
 */
function memberMetrics(events) {
  const count = (t) => events.filter((e) => e.type === t).length;
  const joined = count('member.joined');
  const left = count('member.left');
  const subsStarted = count('sub.started');
  const subsCancelled = count('sub.cancelled');

  return {
    joined,
    left,
    netMembers: joined - left,
    subsStarted,
    subsCancelled,
    netSubs: subsStarted - subsCancelled,
  };
}

/**
 * Content pipeline state. The gaps here are the nag.
 * Matches content.planned -> filmed -> published by payload.ref.
 */
function contentPipeline(events, nowISO) {
  const now = nowISO ? new Date(nowISO) : new Date();
  const byRef = new Map();

  for (const e of events) {
    if (!e.type.startsWith('content.')) continue;
    const ref = e.payload.ref;
    if (!ref) continue;
    if (!byRef.has(ref)) {
      byRef.set(ref, {
        ref,
        planned: null,
        filmed: null,
        published: null,
        platform: e.payload.platform || null,
        title: e.payload.title || ref,
      });
    }
    const item = byRef.get(ref);
    const stage = e.type.split('.')[1];
    item[stage] = e.ts;
    if (e.payload.platform) item.platform = e.payload.platform;
    if (e.payload.title) item.title = e.payload.title;
  }

  const items = [...byRef.values()];
  const hoursSince = (ts) => (now - new Date(ts)) / 36e5;

  return {
    items,
    unfilmed: items.filter((i) => i.planned && !i.filmed),
    // Filmed but sat unposted for over 48h - the most common leak.
    stale: items.filter(
      (i) => i.filmed && !i.published && hoursSince(i.filmed) > 48
    ),
    publishedCount: items.filter((i) => i.published).length,
  };
}

module.exports = {
  toDecimal,
  betProfit,
  tipMetrics,
  memberMetrics,
  contentPipeline,
  round2,
};

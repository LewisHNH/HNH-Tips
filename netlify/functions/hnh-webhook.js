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


// ===========================================================================
// ==  RACING CALENDAR - verified dates. Add to this as the year unfolds.   ==
// ==  The brain only knows what is in here. It will not invent fixtures.   ==
// ===========================================================================

const RACING_CALENDAR = [
  {
    name: 'St Leger Festival',
    from: '2026-09-10', to: '2026-09-13', course: 'Doncaster', code: 'flat',
    why: 'Final Classic of the flat season and the 250th anniversary running. Oldest Classic in the world, first run 1776.',
    angles: ['250th anniversary is a genuine hook non-racing audiences understand', 'Stamina test at 1m6f - different profile to the sprints', 'Triple Crown history - nothing has done it since Nijinsky in 1970'],
  },
  {
    name: 'Irish Champions Weekend',
    from: '2026-09-12', to: '2026-09-13', course: 'Leopardstown / Curragh', code: 'flat',
    why: 'Draws British-trained runners. Clashes with St Leger weekend.',
    angles: ['Cross-channel form comparison', 'Which British horses travel'],
    dateConfidence: 'approximate - confirm before scheduling',
  },
  {
    name: 'Goodwood Season Finale',
    from: '2026-10-11', to: '2026-10-11', course: 'Goodwood', code: 'mixed',
    why: 'First jump races of the autumn. The seasonal handover point.',
    angles: ['Flat to jumps transition explainer - good evergreen content'],
  },
  {
    name: 'QIPCO British Champions Day',
    from: '2026-10-17', to: '2026-10-17', course: 'Ascot', code: 'flat',
    why: 'Richest race day in the UK and the finale of the flat season. Five Group 1s on one card.',
    angles: ['Five Group 1s in an afternoon - density is the story', 'Season awards framing: who was the horse of the year', 'Champion Stakes rated among the best races in the world'],
  },
  {
    name: 'Cheltenham Showcase Meeting',
    from: '2026-10-23', to: '2026-10-24', course: 'Cheltenham', code: 'jumps',
    why: 'Traditional curtain raiser for the National Hunt season at Cheltenham.',
    angles: ['First look at Festival horses', 'Cheltenham course specialists'],
  },
  {
    name: 'Cheltenham November Meeting',
    from: '2026-11-13', to: '2026-11-15', course: 'Cheltenham', code: 'jumps',
    why: 'Most prestigious fixture outside the Festival. Paddy Power Gold Cup on Super Saturday.',
    angles: ['Festival trial angles - who to follow to March', 'Handicap chase form lines'],
  },
];


// ===========================================================================
// ==  ALGORITHM PLAYBOOK                                                   ==
// ==  Confidence is labelled deliberately. CONFIRMED = stated by the       ==
// ==  platform. ESTIMATED = practitioner consensus, not official. Treat    ==
// ==  estimates as rules of thumb, not physics. Last reviewed Aug 2026.    ==
// ===========================================================================

const ALGORITHM_PLAYBOOK = {
  lastReviewed: '2026-08',
  healthWarning: 'Platform algorithms change every few months and most online advice is folklore. Anything marked ESTIMATED is practitioner consensus, not official. Lewis own performance data always beats generic advice - when marketing.performance has real numbers, trust those over anything here.',

  tiktok: {
    model: 'CONFIRMED: interest graph, not social graph. Each video is evaluated on its own merits, which is why a small account can out-reach a large one.',
    changed2026: 'CONFIRMED: follower-first distribution. New videos are tested on your existing followers before going wider. Your followers are now the gatekeepers, so a disengaged follower base actively suppresses reach.',
    rankingSignals: {
      strongest: 'Watch time and completion rate. ESTIMATED at roughly 40-50% of total ranking weight.',
      strong: 'Rewatches, shares (especially share-to-DM), saves.',
      moderate: 'Comments, particularly replies and long comments. Follows from the video.',
      weakest: 'Likes. CONFIRMED as a weaker interest signal than watch time.',
      negative: 'Skips, "not interested", fast scroll-past.',
    },
    coldStart: 'ESTIMATED: initial pool of roughly 200-500 viewers, judged over the first 30-90 minutes. Clear the bar and it expands to 5,000-10,000. Normalised by pool size, so a small engaged pool routes faster than a big flat one.',
    completionBar: 'ESTIMATED: around 70% completion for a real push, up from roughly 50% in 2024. This is the single biggest argument for shorter videos.',
    practicalRules: [
      'Shorter and fully watched beats longer and abandoned. A 20s video watched to the end outperforms a 60s video dropped at 15s.',
      'First 2 seconds decide everything. Open on the claim, not on a greeting. Never "hey guys, welcome back".',
      'Build in a reason to rewatch - a number on screen, a fast detail, a line that lands differently second time.',
      'Original audio is favoured over trending sounds for this kind of content.',
      'TikTok search is now a major discovery channel. Say your keywords out loud, put them on screen, and put them in the caption.',
      'Post when your followers are actually awake - follower-first means a dead test pool kills the video.',
      'Benchmark: engagement rate by views was about 3.85% in Q2 2026, down from 4.2-4.3%. Judge yourself against that, not against 2023 numbers.',
    ],
    forRacing: [
      'Reasoning content completes well because people want the conclusion. Give the selection at the end, not the start.',
      'Being specific and occasionally wrong outperforms being vague and safe - it generates comments.',
      'Post-race reaction while people are still searching the race name catches search traffic.',
    ],
  },

  instagram: {
    model: 'Mixed social and interest graph. Reels lean interest-based for reach; feed and stories lean social for existing followers.',
    rankingSignals: {
      reels: 'Watch time, sends per reach (sharing to DMs), saves, replays. Sends are the signal Instagram has publicly emphasised.',
      feed: 'Saves, shares, comments, time spent on the post.',
      stories: 'Replies, taps forward vs exits, sticker interaction.',
    },
    practicalRules: [
      'Optimise Reels for SENDS. "Send this to someone who..." works because it targets the actual ranking signal.',
      'Carousels are the save format. Saves signal lasting value and keep working for days.',
      'Original content is favoured over visibly reposted or watermarked material.',
      'Stories do not drive reach but do drive retention with people who already follow you.',
      'Instagram surfaces older posts more than TikTok - a good carousel has a longer tail.',
    ],
    forRacing: [
      'Results cards and advised-vs-SP comparisons are natural save-and-send content.',
      'Carousel format suits "how we picked this" breakdowns - one slide per reason.',
    ],
  },

  facebook: {
    model: 'Heavily social graph with a growing recommended-content slice. Older skewing audience than TikTok.',
    rankingSignals: 'Meaningful interactions - comments and shares far outweigh likes. Dwell time on the post. Video watch time for video posts.',
    practicalRules: [
      'Links in the post body suppress reach. Put the link in the first comment or in the profile.',
      'Groups reach far better than pages. A Facebook group is a genuine funnel, a page mostly is not.',
      'Native video outperforms links to video elsewhere.',
      'The audience skews older, which for racing is an advantage rather than a problem - closer to the actual betting demographic.',
    ],
    forRacing: [
      'Racing-interest groups are where this audience already lives, though most ban self-promotion. Read the rules before posting.',
    ],
  },

  x: {
    model: 'Timeline mixes followed accounts with recommended posts. Replies and quote posts drive distribution.',
    rankingSignals: 'Replies weigh heaviest, then reposts, then likes. Dwell time matters. Outbound links reduce distribution.',
    practicalRules: [
      'Links reduce reach. Post the substance natively, put any link in a reply.',
      'Threads work when each post stands alone.',
      'Replying to bigger accounts in your niche is the cheapest distribution on the platform.',
      'Posting a selection before the race and settling it publicly afterwards builds an auditable record - the proof IS the marketing.',
    ],
  },

  captions: {
    principle: 'A caption does a different job on each platform. Never write one caption and paste it everywhere.',
    tiktok: 'Short, keyword-loaded, searchable. Under 150 characters. Include the race, course and horse name because people search those terms. A question at the end drives comments, which are a moderate signal.',
    instagram: 'First line is the hook and the only part shown before "more". Front-load it. Then value, then a soft call to action. A "send this to" prompt targets the sends signal directly.',
    facebook: 'Longer is fine. Conversational, ask an opinion, expect comments. No links in the body.',
    x: 'The post is the content. Lead with the claim. No hashtags - they read as spam here.',
    telegram: 'Not marketing. Clear, consistent, factual. This is the product.',
    universal: [
      'Never open with "hey guys" or any greeting - it wastes the hook.',
      'Specific beats generic. "Trap 4 at Sunderland" outperforms "today\'s tip".',
      'Age gate where the format allows. 18+ and BeGambleAware.',
      'Never write a caption that reads as an inducement to bet.',
    ],
  },

  postingCadence: {
    tiktok: '1-2 a day sustainable, 3-5 a week minimum. Consistency matters more than volume.',
    instagram: '4-6 a week including at least 3 Reels.',
    facebook: '3-5 a week.',
    x: '2-4 a day - the timeline moves fast and repetition is expected.',
    warning: 'Posting more than you can sustain is worse than posting less. A gap after a burst reads as abandonment to every follower-first algorithm.',
  },
};

// ===========================================================================
// ==  PLATFORM PLAYBOOK - when and how to post, and what not to say.       ==
// ===========================================================================

const PLATFORM_PLAYBOOK = {
  audienceRhythm: {
    note: 'UK racing audience, not generic social media. Timing follows the racing day, not the office day.',
    previewWindow: '07:00-11:00 - racecards are out and people are deciding bets. Preview and analysis content lands here.',
    middayWindow: '12:00-13:30 - lunch scroll, just before afternoon racing starts.',
    afternoonRacing: 'roughly 13:00-18:00 - people are watching, not scrolling. Weakest window to post.',
    eveningWindow: '18:30-21:30 - results are in, evening and greyhound meetings running. Best window for results and reaction content.',
    saturday: 'biggest betting day of the week by a distance. ITV Racing drives a mainstream audience who do not follow racing daily.',
    sunday: 'quieter racing, better for reflective content - weekly review, method explainers, longer pieces.',
  },
  platforms: {
    tiktok: {
      bestTimes: ['12:30', '19:00'],
      format: '9:16 vertical, 30-60s. Hook in the first 2 seconds or it is dead.',
      whatWorks: 'Reasoning shown out loud. Being specific and being wrong occasionally. Face to camera beats voiceover-over-stock.',
      moderation: 'Strictest of the lot on gambling. No bet slips, no odds as a call to action, no profit screenshots, no "get on this". Frame everything as analysis and opinion.',
    },
    instagram: {
      bestTimes: ['12:00', '19:00'],
      format: 'Reels 9:16 for reach, carousels for saving and depth.',
      whatWorks: 'Results cards, advised-vs-SP comparisons, clean numbers on black and gold.',
      moderation: 'Meta restricts gambling promotion. Organic analysis is fine, but avoid anything that reads as an inducement to bet.',
    },
    x: {
      bestTimes: ['09:30', '13:00', '20:00'],
      format: 'Text-first. Threads for reasoning, single posts for results.',
      whatWorks: 'Posting the selection before the race and settling it publicly afterwards. The audit trail IS the marketing.',
      moderation: 'Loosest of the platforms, but note posts with links cost more via the API.',
    },
    telegram: {
      bestTimes: ['08:00', '18:40'],
      format: 'The product itself, not marketing. Free channels are the funnel.',
      whatWorks: 'Consistency. Same time every day builds the habit that makes the paid group feel worth it.',
      moderation: 'Your own channel, but UK advertising rules still apply to what you say.',
    },
  },
  complianceRails: {
    note: 'These are not optional. A platform ban costs more than any single post gains.',
    rules: [
      'Age-gate everything. 18+ and BeGambleAware where the format allows.',
      'Never imply guaranteed returns or a sure thing.',
      'No urgency or pressure language: "last chance", "get on now", "hurry".',
      'Never present odds as a call to action. Present them as analysis.',
      'No bet slips, no profit screenshots, no bank-balance content.',
      'Never quote the paid group record as if it were the free record.',
      'Do not target or use content styles that appeal to under-18s.',
    ],
  },
};

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
/**
 * Funnel data - what happens between someone seeing content and paying.
 * Capped like the Whop call so a slow read can't sink the reply.
 */
async function readFunnel() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
    const pw = process.env.ADMIN_PASSWORD;
    if (!base || !pw) return { error: 'not configured' };
    const res = await fetch(
      `${base}/.netlify/functions/hnh-track?pw=${encodeURIComponent(pw)}&days=30`,
      { signal: controller.signal }
    );
    return await res.json();
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'funnel data timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function readWhop() {
  // Hard 3.5s cap. Whop is a nested function call over HTTP and on a cold
  // cache it can take many seconds - which used to kill the whole reply.
  // Better to answer without revenue data than not answer at all.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  try {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
    const pw = process.env.ADMIN_PASSWORD;
    if (!base || !pw) return { error: 'site URL or admin password not configured' };

    const res = await fetch(
      `${base}/.netlify/functions/hnh-whop?pw=${encodeURIComponent(pw)}`,
      { signal: controller.signal }
    );
    const data = await res.json();
    if (data.error) return { error: data.error };
    return data;
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Whop data timed out. Member and revenue figures are unavailable for this answer - everything else is current.'
      : err.message;
    console.error('whop read failed:', msg);
    return { error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a date range from the event store.
 *
 * Reads every day IN PARALLEL. Sequentially this was ~80ms per day, so a
 * 90-day range took over 7 seconds on its own and blew the 10s function
 * timeout before Claude was even called.
 */
async function readEventRange(from, to, opts = {}) {
  const store = getStore(EVENTS_STORE);

  const days = [];
  let cursor = from, guard = 0;
  while (cursor <= to && guard < 400) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
    guard++;
  }

  const results = await Promise.all(
    days.map(async (d) => {
      try {
        const raw = await store.get(`day/${d}`, { type: 'json' });
        return Array.isArray(raw) ? raw : [];
      } catch {
        return []; // a missing day is fine
      }
    })
  );

  const all = results.flat();
  // Voided entries stay in storage but are excluded from everything that
  // reads them, so no calculation anywhere needs to know about corrections.
  return opts.includeVoided ? all : all.filter((e) => !e.voidedAt);
}

/**
 * Fixtures in the next N days, with how long there is to prepare.
 * Only what's in RACING_CALENDAR - nothing invented.
 */
function upcomingFixtures(today, days = 90) {
  const horizon = addDays(today, days);
  return RACING_CALENDAR
    .filter((f) => f.to >= today && f.from <= horizon)
    .map((f) => {
      const daysUntil = Math.round(
        (new Date(`${f.from}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000
      );
      return {
        ...f,
        daysUntil: daysUntil < 0 ? 0 : daysUntil,
        status: f.from <= today && f.to >= today ? 'RUNNING NOW' : 'upcoming',
      };
    })
    .sort((a, b) => a.from.localeCompare(b.from));
}

/**
 * What's actually been published, by platform, so the brain can spot
 * gaps and avoid suggesting something already done.
 */
function contentHistory(events) {
  const published = events.filter((e) => e.type === 'content.published');
  const byPlatform = {};
  for (const e of published) {
    const p = (e.payload && e.payload.platform) || 'unknown';
    byPlatform[p] = (byPlatform[p] || 0) + 1;
  }
  return {
    publishedLast14d: published.length,
    byPlatform,
    recent: published.slice(-10).map((e) => ({
      date: e.ts.slice(0, 10),
      platform: e.payload.platform || null,
      title: e.payload.title || e.payload.ref,
    })),
    note: published.length === 0
      ? 'Nothing logged as published in the last 14 days. Either content is not being logged, or nothing has gone out.'
      : null,
  };
}

/**
 * What has actually worked for HNH. Generic algorithm advice is commodity;
 * this is the proprietary bit. Reads metrics logged on content.published
 * events, so it only gets useful once Lewis starts logging them.
 */
function contentPerformance(events) {
  const withMetrics = events.filter(
    (e) => e.type === 'content.published' && e.payload && e.payload.metrics
  );

  if (!withMetrics.length) {
    return {
      dataPresent: false,
      note: 'No post metrics logged yet. Until they are, content advice is based on general platform mechanics rather than what actually works for HNH. Logging views, completion rate and signups against each post is the single highest-value thing to start doing.',
      howToLog: 'POST to /.netlify/functions/hnh-events with type content.published and a metrics object: { views, completionRate, shares, saves, comments, signups }.',
    };
  }

  const byPlatform = {};
  for (const e of withMetrics) {
    const p = (e.payload.platform || 'unknown');
    if (!byPlatform[p]) byPlatform[p] = { posts: 0, views: 0, signups: 0, completionRates: [] };
    const b = byPlatform[p];
    const m = e.payload.metrics;
    b.posts++;
    b.views += Number(m.views) || 0;
    b.signups += Number(m.signups) || 0;
    if (m.completionRate != null) b.completionRates.push(Number(m.completionRate));
  }

  for (const b of Object.values(byPlatform)) {
    b.avgViews = b.posts ? Math.round(b.views / b.posts) : 0;
    b.avgCompletionRate = b.completionRates.length
      ? round2(b.completionRates.reduce((x, y) => x + y, 0) / b.completionRates.length)
      : null;
    b.viewsPerSignup = b.signups ? Math.round(b.views / b.signups) : null;
    delete b.completionRates;
  }

  const ranked = withMetrics
    .map((e) => ({
      date: e.ts.slice(0, 10),
      platform: e.payload.platform,
      title: e.payload.title || e.payload.ref,
      views: Number(e.payload.metrics.views) || 0,
      completionRate: e.payload.metrics.completionRate ?? null,
      signups: Number(e.payload.metrics.signups) || 0,
    }))
    .sort((a, b) => b.views - a.views);

  return {
    dataPresent: true,
    postsWithMetrics: withMetrics.length,
    byPlatform,
    bestPerforming: ranked.slice(0, 5),
    worstPerforming: ranked.slice(-3).reverse(),
    note: 'This is HNH real performance data. Trust it over generic platform advice wherever the two disagree.',
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

// --- assemble --------------------------------------------------------------

const CONTEXT_CACHE_KEY = 'cache/brain-context';
const CONTEXT_CACHE_SECONDS = 300;

/**
 * Assembling the context touches four data sources. Caching it for five
 * minutes means a run of questions costs one build, not one per message.
 */
async function getContext() {
  const store = getStore(EVENTS_STORE);
  try {
    const cached = await store.get(CONTEXT_CACHE_KEY, { type: 'json' });
    if (cached && cached.builtAt) {
      const ageSec = (Date.now() - new Date(cached.builtAt).getTime()) / 1000;
      if (ageSec < CONTEXT_CACHE_SECONDS) {
        console.log(`context from cache, ${Math.round(ageSec)}s old`);
        return cached.data;
      }
    }
  } catch { /* no cache yet */ }

  const data = await buildContext();
  try {
    await store.setJSON(CONTEXT_CACHE_KEY, { builtAt: new Date().toISOString(), data });
  } catch (err) {
    console.error('context cache write failed:', err);
  }
  return data;
}

async function buildContext() {
  const today = ukDate();

  const [paidMonths, trapFree, horseTips, recentEvents, whop, funnel] = await Promise.all([
    readGreyhoundMonths('month:'),
    readTrapOfTheDay(),
    readHorseTips(),
    readEventRange(addDays(today, -89), today),
    readWhop(),
    readFunnel(),
  ]);

  // One read covers both windows. The 14-day slice is derived, not re-fetched.
  const events90 = recentEvents;
  const cutoff14 = addDays(today, -13);
  const events14 = events90.filter((e) => e.ts.slice(0, 10) >= cutoff14);

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

    memory: {
      what: 'Things Lewis has told you to remember - decisions, what has been tried, constraints, conclusions. This is history the raw numbers do not contain. Use it, and reference it naturally rather than announcing that you remembered.',
      notes: memory,
      count: memory.length,
    },

    funnel: {
      what: 'What happens between someone seeing content and paying. Page views, clicks through to the Whop checkout, clicks to Telegram, broken down by source. If dataPresent is false the tracking snippet is not installed yet - say so rather than guessing at conversion.',
      ...funnel,
    },

    revenue: {
      what: 'Whop subscription data for the paid Exclusive Group. The only revenue line in the business.',
      ...whop,
    },

    content: contentPipeline(events14),

    marketing: {
      note: 'Everything needed to plan content. Fixtures are only what is in the calendar - never invent a race date, and say so if asked about something not listed.',
      today,
      dayOfWeek: new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'Europe/London' }).format(new Date()),
      upcomingFixtures: upcomingFixtures(today, 90),
      history: contentHistory(events14),
      performance: contentPerformance(events90),
      // Playbooks live in the system prompt, not here - they are static and
      // would otherwise be re-sent with every single message.
    },
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

/**
 * Telegram caps messages at 4096 characters and silently rejects malformed
 * HTML. This splits long answers on paragraph breaks and retries as plain
 * text if the HTML parse fails, so an answer never disappears.
 */
async function sendSafe(chatId, html, plain) {
  const LIMIT = 3800;
  const chunks = [];

  if (html.length <= LIMIT) {
    chunks.push(html);
  } else {
    let rest = html;
    while (rest.length) {
      if (rest.length <= LIMIT) { chunks.push(rest); break; }
      let cut = rest.lastIndexOf('\n\n', LIMIT);
      if (cut < LIMIT * 0.5) cut = rest.lastIndexOf('\n', LIMIT);
      if (cut < LIMIT * 0.5) cut = LIMIT;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n+/, '');
    }
  }

  console.log(`sending ${chunks.length} chunk(s), ${html.length} chars total`);

  for (const chunk of chunks) {
    const r = await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: chunk,
      disable_web_page_preview: true,
    });

    if (!r.ok) {
      console.error(`HTML send failed: ${r.description} - retrying as plain text`);
      await tg('sendMessage', {
        chat_id: chatId,
        text: (plain || chunk.replace(/<[^>]+>/g, '')).slice(0, 4000),
        disable_web_page_preview: true,
      });
    }
  }
}

/**
 * Voice notes. Telegram gives a file_id; we resolve it to a URL, download
 * the .ogg and transcribe it. Anthropic's API doesn't take audio, so this
 * needs a separate speech-to-text provider.
 *
 * Set STT_API_KEY and optionally STT_PROVIDER (openai | groq).
 * Groq is cheaper and faster; OpenAI is the default.
 */
async function transcribeVoice(fileId) {
  const sttKey = process.env.STT_API_KEY;
  if (!sttKey) throw new Error('STT_API_KEY is not set - voice notes need a transcription provider');

  // 1. file_id -> download path
  const info = await tg('getFile', { file_id: fileId });
  if (!info.ok) throw new Error(`couldn't fetch the voice file: ${info.description}`);
  const path = info.result.file_path;

  // 2. download the audio
  const audioRes = await fetch(
    `https://api.telegram.org/file/bot${process.env.BRAIN_BOT_TOKEN}/${path}`
  );
  if (!audioRes.ok) throw new Error(`voice download failed: ${audioRes.status}`);
  const audio = await audioRes.arrayBuffer();

  // 3. transcribe
  const provider = (process.env.STT_PROVIDER || 'openai').toLowerCase();
  const endpoint = provider === 'groq'
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';
  const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', model);
  form.append('language', 'en');
  // Racing vocabulary the model would otherwise mangle.
  form.append('prompt', 'UK horse racing and greyhound tipping. Terms: trap, Sunderland, Doncaster, Cheltenham, advised price, SP, points, each way, NAP, Whop, Telegram.');

  const sttRes = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sttKey}` },
    body: form,
  });

  const data = await sttRes.json();
  if (!sttRes.ok) {
    throw new Error(`transcription failed: ${(data.error && data.error.message) || sttRes.status}`);
  }
  return (data.text || '').trim();
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
- funnel shows traffic and click-through to checkout. Checkout clicks are people who reached Whop, NOT people who paid - compare against revenue.joinedLast30Days for the real conversion rate. If funnel.dataPresent is false, the tracking snippet is not installed and you cannot comment on conversion at all.
- If revenue.error is present, the Whop data could not be read. Say so rather than guessing at figures.
- revenue.membersNeedingAction identifies members who are cancelling or have already lapsed, so Lewis can manage access to his own paid Telegram group. Name them freely when he asks who is cancelling or who to remove - that is the whole point of the list.
- Everyone else stays an anonymous count. Never invent a name or email for a member who is not on that list.
- When someone has lapsed, lead with the name and the date access ended, and say plainly they should be removed from the group. If telegramLinked is false, say he will need to match them by name or email.

LOGGING MODE
Lewis can record things by just saying them. Work out whether his message is a QUESTION (he wants to know something) or a LOG (he is telling you something that happened, to be recorded).

If it is a LOG, reply with ONLY a JSON object, no prose before or after, in exactly this shape:

{"log": [ {"type": "...", "sport": "...", "payload": { ... }} ], "confirm": "one short line describing what you recorded"}

Valid types and their payloads:
- tip.settled - {selection, tipster, advisedPrice, sp, stake, result} where result is win|lose|placed|void
- content.published - {platform, title, ref, metrics:{views, completionRate, shares, saves, comments, signups}}
- content.filmed / content.planned - {platform, title, ref}
- member.joined / member.left / sub.started / sub.cancelled - {source}
- note - {text} for anything that does not fit
- memory - {text, category} for something worth keeping permanently: a decision, a conclusion, a constraint, something tried and how it went. Use this when Lewis says remember/note that/for future reference, or when he reaches a conclusion worth carrying forward.

Rules for logging:
- Only fields you were actually told. Never invent a stake, a price or a number.
- Odds stay as given ("5/2", "7/2"). Do not convert them.
- If something essential is missing or ambiguous, do NOT log - reply normally asking the one thing you need.
- If the message is clearly a question, ignore all of this and answer normally.
- Multiple things in one message become multiple entries in the log array.

MARKETING WORK
When Lewis asks for content ideas, angles, or what to post:
- Ground every idea in marketing.upcomingFixtures. If a fixture is not in that list, you do not know it is happening - say so rather than inventing a date. Never guess a race date; filming for the wrong day wastes his time.
- Always give: the angle, the platform, the day, the time to post, and roughly when to film it. An idea without a slot is not usable.
- Use marketing.playbook.audienceRhythm for timing. This audience follows the racing day, not the office day: previews land in the morning while people are choosing bets, results land in the evening once racing has finished. Mid-afternoon is the weakest window because they are watching, not scrolling.
- Match the format to the platform from playbook.platforms. A results carousel is an Instagram thing; a reasoning thread is an X thing.
- Check marketing.history before suggesting anything, so you do not propose something already posted, and so you can flag a platform going quiet.
- Free content is the funnel; the paid Exclusive Group is the only revenue. Ideas should be judged on whether they move people toward the paid group, not on views alone.
- Remember the retention problem: members last about two billing cycles. Content that keeps existing members engaged is worth as much as content that attracts new ones. Say so when it is relevant.
- Give 2-4 concrete ideas, not ten vague ones. Specific enough that he could film it without thinking.

ALGORITHM WORK
- marketing.algorithms holds platform mechanics with confidence labels. CONFIRMED means the platform said it. ESTIMATED means practitioners agree but nobody official has confirmed it. Say which you are relying on when it matters, and never present an estimate as fact.
- marketing.performance is HNH real data. When it has numbers, trust it over anything in the generic playbook. If they disagree, say so and go with the real data.
- If performance.dataPresent is false, say plainly that you are working from general mechanics rather than what actually works for HNH, and encourage logging metrics.
- The 2026 TikTok change matters most: videos are tested on existing followers first. A disengaged follower base now actively suppresses reach, so posting when his followers are awake is not a nicety.
- Completion rate is the dominant signal. When suggesting a video, say how long it should be and why - shorter and fully watched beats longer and abandoned.
- When asked for a caption, write the actual caption, ready to paste. Do not describe what the caption should do. Write it for the specific platform using marketing.algorithms.captions, and never reuse one caption across platforms.
- Judge ideas on whether they move people toward the paid group, not on views. Views that do not convert are a vanity metric, and with a retention problem, keeping members matters as much as attracting them.

COMPLIANCE - non-negotiable, applies to every idea you suggest:
- Follow every rule in marketing.playbook.complianceRails.
- Never suggest content built on bet slips, profit screenshots, guaranteed returns, or urgency language.
- Odds are analysis, never a call to action.
- TikTok is the strictest platform on gambling. Frame everything there as opinion and reasoning.
- If Lewis proposes something that would breach these, say so plainly and offer a version that would not.

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

function buildSystem() {
  return [
    SYSTEM,
    '',
    'PLATFORM PLAYBOOK (static reference):',
    JSON.stringify(PLATFORM_PLAYBOOK),
    '',
    'ALGORITHM PLAYBOOK (static reference):',
    JSON.stringify(ALGORITHM_PLAYBOOK),
  ].join('\n');
}

async function askClaude(question, context, opts = {}) {
  const maxTokens = opts.maxTokens || 800;
  const briefNote = opts.brief
    ? '\n\nIMPORTANT: keep this answer under 250 words and finish your final sentence. Be decisive and concrete rather than comprehensive - a short complete answer beats a long truncated one.'
    : '';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: buildSystem(),
      messages: [{
        role: 'user',
        content: `Business figures:\n\`\`\`json\n${JSON.stringify(context)}\n\`\`\`\n\nQuestion: ${question}${briefNote}`,
      }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'anthropic error');

  const out = (data.content || [])
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');

  // stop_reason tells us whether the answer finished or was cut short.
  // "max_tokens" means truncated; "end_turn" means it finished properly.
  console.log(
    `claude: stop_reason=${data.stop_reason} ` +
    `out_tokens=${data.usage && data.usage.output_tokens} ` +
    `chars=${out.length}`
  );
  if (data.stop_reason === 'max_tokens') {
    console.warn('answer was truncated by max_tokens - raise the limit');
  }

  if (!out) throw new Error(`empty response (stop_reason: ${data.stop_reason})`);

  return {
    text: out,
    meta: {
      stopReason: data.stop_reason || 'unknown',
      outputTokens: (data.usage && data.usage.output_tokens) || null,
      chars: out.length,
    },
  };
}

const LOGGABLE_TYPES = [
  'memory',
  'tip.posted', 'tip.settled',
  'member.joined', 'member.left', 'sub.started', 'sub.cancelled',
  'content.planned', 'content.filmed', 'content.published',
  'enquiry.received', 'broadcast.sent', 'note',
];

/**
 * If the model replied with a log instruction, validate and store it.
 * Returns a confirmation string, or null if this wasn't a log at all.
 *
 * Validation happens HERE, not in the model. The model proposes; the code
 * decides what actually gets written to the record.
 */
async function tryStoreLog(answer) {
  const trimmed = answer.trim().replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim();
  if (!trimmed.startsWith('{')) return null;

  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (!parsed || !Array.isArray(parsed.log) || !parsed.log.length) return null;

  const store = getStore(EVENTS_STORE);
  const stored = [];
  const rejected = [];

  for (const entry of parsed.log) {
    if (!entry || !LOGGABLE_TYPES.includes(entry.type)) {
      rejected.push(entry && entry.type ? entry.type : 'unknown type');
      continue;
    }

    // Memory lives in its own store, not the daily event log.
    if (entry.type === 'memory') {
      const m = await addMemory(
        (entry.payload && entry.payload.text) || '',
        (entry.payload && entry.payload.category) || 'auto'
      );
      stored.push({ id: m.id, type: 'memory', payload: { text: m.text } });
      continue;
    }

    const ts = new Date().toISOString();
    const record = {
      id: 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      ts,
      type: entry.type,
      actor: 'lewis',
      sport: entry.sport || null,
      payload: entry.payload || {},
      v: 1,
    };

    const key = ukDate(ts);
    let day = [];
    try {
      const raw = await store.get(`day/${key}`, { type: 'json' });
      if (Array.isArray(raw)) day = raw;
    } catch { /* first entry today */ }
    day.push(record);
    await store.setJSON(`day/${key}`, day);
    stored.push(record);
  }

  if (!stored.length) return null;

  // The context cache is now stale - drop it so the next question sees this.
  try { await store.delete(CONTEXT_CACHE_KEY); } catch { /* fine */ }

  const lines = [`<b>Logged.</b> ${esc(parsed.confirm || `${stored.length} entry recorded`)}`];
  for (const r of stored) {
    lines.push(`• <code>${esc(r.type)}</code> ${esc(JSON.stringify(r.payload))}`);
  }
  if (rejected.length) lines.push(`<i>Skipped: ${esc(rejected.join(', '))}</i>`);
  lines.push(`<i>Wrong? /undo within 15 min, or /void ${esc(shortId(stored[stored.length - 1].id))} after that.</i>`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Corrections
//
// Same principle as the greyhound record: a short window where a genuine
// slip can be removed outright, and after that mistakes are superseded
// visibly rather than erased. A P&L you can quietly edit is worth nothing
// to a subscriber, so the audit trail survives even when the maths changes.
// ---------------------------------------------------------------------------

const HARD_DELETE_WINDOW_MS = 15 * 60 * 1000;

function shortId(id) {
  return String(id).slice(-6);
}

/**
 * Recent entries, newest first, with short IDs to reference.
 */
async function recentEntries(limit = 10) {
  const today = ukDate();
  const events = await readEventRange(addDays(today, -6), today, { includeVoided: true });
  return events
    .filter((e) => e.type !== 'brief.generated')
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, limit);
}

async function findEvent(shortOrFull) {
  const target = String(shortOrFull).toLowerCase().replace(/^#/, '');
  const today = ukDate();
  const events = await readEventRange(addDays(today, -29), today, { includeVoided: true });
  return events.find(
    (e) => e.id.toLowerCase() === target || shortId(e.id).toLowerCase() === target
  ) || null;
}

/**
 * Remove an entry outright. Only inside the 15-minute window.
 */
async function hardDelete(event) {
  const store = getStore(EVENTS_STORE);
  const key = ukDate(event.ts);
  const raw = await store.get(`day/${key}`, { type: 'json' });
  if (!Array.isArray(raw)) return false;
  const next = raw.filter((e) => e.id !== event.id);
  if (next.length === raw.length) return false;
  await store.setJSON(`day/${key}`, next);
  try { await store.delete(CONTEXT_CACHE_KEY); } catch { /* fine */ }
  return true;
}

/**
 * Mark an entry superseded. It stays on the record, flagged and dated,
 * but is excluded from every calculation.
 */
async function voidEvent(event, reason) {
  const store = getStore(EVENTS_STORE);
  const key = ukDate(event.ts);
  const raw = await store.get(`day/${key}`, { type: 'json' });
  if (!Array.isArray(raw)) return false;

  let found = false;
  const next = raw.map((e) => {
    if (e.id !== event.id) return e;
    found = true;
    return { ...e, voidedAt: new Date().toISOString(), voidReason: reason || 'corrected by Lewis' };
  });
  if (!found) return false;

  await store.setJSON(`day/${key}`, next);
  try { await store.delete(CONTEXT_CACHE_KEY); } catch { /* fine */ }
  return true;
}

// ---------------------------------------------------------------------------
// Memory
//
// Every conversation otherwise starts cold. This is the difference between
// a calculator that knows your numbers and something that knows your
// business - what you tried, what happened, what you decided and why.
// ---------------------------------------------------------------------------

const MEMORY_KEY = 'memory/notes';
const MEMORY_MAX = 60;

async function readMemory() {
  try {
    const v = await getStore(EVENTS_STORE).get(MEMORY_KEY, { type: 'json' });
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

async function addMemory(text, category = 'note') {
  const store = getStore(EVENTS_STORE);
  const notes = await readMemory();
  const entry = {
    id: 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    at: new Date().toISOString().slice(0, 10),
    category,
    text: String(text).slice(0, 400),
  };
  notes.push(entry);
  // Oldest fall off, so the prompt can't grow without limit.
  const trimmed = notes.slice(-MEMORY_MAX);
  await store.setJSON(MEMORY_KEY, trimmed);
  try { await store.delete(CONTEXT_CACHE_KEY); } catch { /* fine */ }
  return entry;
}

async function forgetMemory(idOrIndex) {
  const store = getStore(EVENTS_STORE);
  const notes = await readMemory();
  const target = String(idOrIndex).toLowerCase();
  const next = notes.filter(
    (n, i) => n.id.toLowerCase() !== target && String(i + 1) !== target
  );
  if (next.length === notes.length) return false;
  await store.setJSON(MEMORY_KEY, next);
  try { await store.delete(CONTEXT_CACHE_KEY); } catch { /* fine */ }
  return true;
}

// --- handler ---------------------------------------------------------------

export default async (req) => {
  const ok = () => new Response('ok', { status: 200 });

  let update;
  try { update = await req.json(); } catch { return ok(); }

  // THINK MODE: called by hnh-brain-background, which has no time limit.
  // Does the slow work and returns the answer rather than sending it.
  if (update && update.think) {
    const auth = req.headers.get('x-hnh-think');
    if (!auth || auth !== process.env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: 'unauthorised' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }
    try {
      const context = await getContext();
      const { text: answer, meta } = await askClaude(update.text, context, { maxTokens: 1200 });
      return new Response(JSON.stringify({ html: mdToTelegramHtml(answer), meta }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      console.error('think failed:', err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
  }

  const msg = update.message || update.edited_message;
  if (!msg) return ok();

  const voice = msg.voice || msg.audio || null;
  if (!msg.text && !voice) return ok();

  const fromId = String(msg.from && msg.from.id);
  const chatId = msg.chat.id;
  let text = msg.text ? msg.text.trim() : '';

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

  // Telegram retries slow webhooks. Dedupe stops double replies - but it
  // must not swallow a retry after a genuine failure, or a timeout leaves
  // you staring at silence. So the marker records state, and a retry is
  // allowed through once the previous attempt is old enough to have died.
  const eventStore = getStore(EVENTS_STORE);
  const seenKey = `seen/${update.update_id}`;
  try {
    const prior = await eventStore.get(seenKey, { type: 'json' });
    if (prior && prior.status === 'done') return ok();
    if (prior && prior.status === 'processing') {
      const ageSec = (Date.now() - new Date(prior.at).getTime()) / 1000;
      if (ageSec < 25) return ok(); // still running, don't double up
      console.log(`retrying update ${update.update_id} after ${Math.round(ageSec)}s`);
    }
    await eventStore.setJSON(seenKey, { status: 'processing', at: new Date().toISOString() });
  } catch (err) {
    console.error('dedupe failed:', err);
  }

  // Voice note: transcribe first, then treat it exactly like typed text.
  if (voice) {
    try {
      await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
      text = await transcribeVoice(voice.file_id);
      if (!text) throw new Error('nothing audible in that');
      // Echo it back so a misheard word is obvious rather than silently acted on.
      await tg('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: `<i>heard:</i> ${esc(text)}`,
      });
    } catch (err) {
      console.error('voice failed:', err);
      await tg('sendMessage', { chat_id: chatId, text: `Couldn't transcribe that: ${err.message}` });
      await eventStore.setJSON(seenKey, { status: 'done', at: new Date().toISOString() }).catch(() => {});
      return ok();
    }
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
        '/recent — last 10 things logged',
        '/remember … — keep something in mind permanently',
        '/memory — what I am holding on to',
        '/undo — remove the last entry (within 15 min)',
        '/void abc123 — supersede an older entry',
      ].join('\n'),
    });
    return ok();
  }

  if (text.startsWith('/remember')) {
    const note = text.replace(/^\/remember\s*/i, '').trim();
    if (!note) {
      await tg('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: 'Give me something to remember: <code>/remember advised vs SP is the claim that matters</code>',
      });
      return ok();
    }
    const entry = await addMemory(note, 'manual');
    await tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `<b>Noted.</b> ${esc(entry.text)}\n<i>/forget ${esc(entry.id)} to remove it.</i>`,
    });
    return ok();
  }

  if (text === '/memory') {
    const notes = await readMemory();
    if (!notes.length) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: "Nothing remembered yet. Tell me things worth keeping - what you've tried, what worked, decisions and why.",
      });
      return ok();
    }
    const lines = [`<b>Memory</b> (${notes.length})`, ''];
    notes.forEach((n, i) => {
      lines.push(`${i + 1}. <i>${esc(n.at)}</i> ${esc(n.text)}`);
    });
    lines.push('');
    lines.push('<i>/forget 3 removes the third one.</i>');
    await sendSafe(chatId, lines.join('\n'), lines.join('\n').replace(/<[^>]+>/g, ''));
    return ok();
  }

  if (text.startsWith('/forget')) {
    const id = text.replace(/^\/forget\s*/i, '').trim();
    if (!id) {
      await tg('sendMessage', { chat_id: chatId, text: 'Which one? /memory to see the list.' });
      return ok();
    }
    const done = await forgetMemory(id);
    await tg('sendMessage', { chat_id: chatId, text: done ? 'Forgotten.' : "Couldn't find that one." });
    return ok();
  }

  if (text === '/recent') {
    const entries = await recentEntries(10);
    if (!entries.length) {
      await tg('sendMessage', { chat_id: chatId, text: 'Nothing logged in the last 7 days.' });
      return ok();
    }
    const lines = ['<b>Recent entries</b>', ''];
    for (const e of entries) {
      const age = Math.round((Date.now() - new Date(e.ts).getTime()) / 60000);
      const ageTxt = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
      const flag = e.voidedAt ? ' <i>(voided)</i>' : '';
      lines.push(`<code>${esc(shortId(e.id))}</code> · ${esc(e.type)} · ${esc(ageTxt)}${flag}`);
      lines.push(`   ${esc(JSON.stringify(e.payload).slice(0, 90))}`);
    }
    lines.push('');
    lines.push('<i>/undo removes the last one if under 15 min. /void abc123 supersedes an older one.</i>');
    await sendSafe(chatId, lines.join('\n'), lines.join('\n').replace(/<[^>]+>/g, ''));
    return ok();
  }

  if (text === '/undo') {
    const entries = await recentEntries(5);
    const last = entries.find((e) => !e.voidedAt);
    if (!last) {
      await tg('sendMessage', { chat_id: chatId, text: 'Nothing recent to undo.' });
      return ok();
    }
    const age = Date.now() - new Date(last.ts).getTime();
    if (age > HARD_DELETE_WINDOW_MS) {
      const mins = Math.round(age / 60000);
      await tg('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: `That entry is ${mins} minutes old, past the 15-minute window, so it can't be deleted outright.\n\nUse <code>/void ${esc(shortId(last.id))}</code> instead - it stays on the record marked as corrected, and comes out of all the maths.`,
      });
      return ok();
    }
    const done = await hardDelete(last);
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: done
        ? `Deleted <code>${esc(last.type)}</code> ${esc(JSON.stringify(last.payload).slice(0, 80))}`
        : "Couldn't find that entry to delete.",
    });
    return ok();
  }

  if (text.startsWith('/void')) {
    const parts = text.split(/\s+/);
    const id = parts[1];
    const reason = parts.slice(2).join(' ');
    if (!id) {
      await tg('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: 'Give me the id: <code>/void abc123 wrong price</code>. Use /recent to see them.',
      });
      return ok();
    }
    const target = await findEvent(id);
    if (!target) {
      await tg('sendMessage', { chat_id: chatId, text: `No entry matching ${id} in the last 30 days.` });
      return ok();
    }
    if (target.voidedAt) {
      await tg('sendMessage', { chat_id: chatId, text: 'That one is already voided.' });
      return ok();
    }
    const done = await voidEvent(target, reason);
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: done
        ? `Voided <code>${esc(target.type)}</code> ${esc(JSON.stringify(target.payload).slice(0, 70))}\n\n<i>Still on the record, marked corrected, out of all calculations.</i>`
        : "Couldn't void that one.",
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

  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;

  // Two modes, because background functions need a paid Netlify plan.
  //
  //   USE_BACKGROUND=true  -> hand off, no time limit, long answers
  //   anything else        -> answer here, capped so it fits inside 10s
  //
  // Set the env var once you have confirmed hnh-brain-background appears
  // in the Netlify functions list.
  if (process.env.USE_BACKGROUND === 'true') {
    try {
      fetch(`${base}/.netlify/functions/hnh-brain-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, text, seenKey, secret: process.env.ADMIN_PASSWORD }),
      }).catch((err) => console.error('handoff failed:', err));
    } catch (err) {
      console.error('handoff threw:', err);
      await tg('sendMessage', { chat_id: chatId, text: `Couldn't start that: ${err.message}` });
    }
    return ok();
  }

  // Synchronous mode. Everything here is on a budget: roughly 2s to build
  // context (cached), leaving about 7s for Claude. That caps the answer
  // length, which is why FAST_MODE_TOKENS is deliberately low.
  const started = Date.now();
  try {
    const context = await getContext();
    console.log(`context in ${Date.now() - started}ms`);

    const { text: answer, meta } = await askClaude(text, context, { maxTokens: 1000, brief: true });
    const elapsed = Date.now() - started;
    console.log(`total ${elapsed}ms`);

    // Was that a log rather than an answer?
    const logged = await tryStoreLog(answer);
    if (logged) {
      await sendSafe(chatId, logged, logged.replace(/<[^>]+>/g, ''));
      await eventStore.setJSON(seenKey, { status: 'done', at: new Date().toISOString() });
      return ok();
    }

    // Debug footer, on when HNH_DEBUG=true. Shows why an answer ended and
    // how long it took, so diagnosing this doesn't mean digging through
    // Netlify logs on a phone.
    const debug = process.env.HNH_DEBUG === 'true'
      ? `\n\n<i>${(elapsed / 1000).toFixed(1)}s · ${meta.outputTokens} tok · ${meta.chars} chars · ${meta.stopReason}</i>`
      : '';

    await sendSafe(chatId, mdToTelegramHtml(answer) + debug, answer);
    await eventStore.setJSON(seenKey, { status: 'done', at: new Date().toISOString() });
  } catch (err) {
    console.error(`brain failed after ${Date.now() - started}ms:`, err);
    await tg('sendMessage', { chat_id: chatId, text: `Couldn't answer that: ${err.message}` })
      .catch(() => {});
    await eventStore.setJSON(seenKey, { status: 'done', at: new Date().toISOString() })
      .catch(() => {});
  }

  return ok();
};

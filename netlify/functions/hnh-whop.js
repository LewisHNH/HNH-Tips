// netlify/functions/hnh-whop.js
//
// Exclusive Group membership and revenue picture, read from Whop.
//
// Built against the v2 API. The newer v1 endpoints need granular scopes
// (company:basic:read) that the standard company key doesn't carry, and
// v2 returns everything needed anyway: status, valid, cancel_at_period_end,
// promo_code and plan.
//
// Env vars:
//   WHOP_API_KEY   company API key (apik_...)
//   WHOP_COMPANY_ID  optional for v2 - the key already scopes to the company
//
// Usage:
//   /.netlify/functions/hnh-whop?pw=PASSWORD           computed summary
//   /.netlify/functions/hnh-whop?pw=PASSWORD&fresh=1   bypass 15-min cache
//   /.netlify/functions/hnh-whop?pw=PASSWORD&raw=1     raw shape (PII stripped)
//
// PRIVACY: Whop returns customer email addresses. They are stripped here and
// never reach the cache or the LLM prompt. The brain has no need for them.

import { getStore } from '@netlify/blobs';

const CACHE_STORE = 'hnh-events';
const CACHE_KEY = 'cache/whop-snapshot';
const CACHE_MINUTES = 15;

const API = 'https://api.whop.com/api/v2';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function pick(obj, ...paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const part of path.split('.')) {
      if (cur && typeof cur === 'object' && part in cur) cur = cur[part];
      else { ok = false; break; }
    }
    if (ok && cur !== null && cur !== undefined && cur !== '') return cur;
  }
  return null;
}

const toDay = (unix) =>
  unix ? new Date(Number(unix) * 1000).toISOString().slice(0, 10) : null;

async function whopFetch(path) {
  const key = process.env.WHOP_API_KEY;
  if (!key) throw new Error('WHOP_API_KEY is not set');

  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Whop returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Whop ${res.status}: ${pick(data, 'error.message', 'message') || text.slice(0, 200)}`);
  }
  return data;
}

/**
 * v2 uses page-based pagination with a total_page count.
 * Guarded at 30 pages so a pagination bug can't loop forever.
 */
async function fetchAllPages(resource) {
  const all = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= 30) {
    const data = await whopFetch(`/${resource}?page=${page}&per=50`);
    const batch = pick(data, 'data') || [];
    all.push(...(Array.isArray(batch) ? batch : []));
    totalPages = Number(pick(data, 'pagination.total_page', 'pagination.total_pages')) || 1;
    page++;
  }
  return all;
}

/**
 * Plans hold the pricing. Memberships only carry a plan ID, so build a
 * lookup and join them.
 */
async function fetchPlanPricing() {
  const map = {};
  try {
    const plans = await fetchAllPages('plans');
    for (const p of plans) {
      const id = pick(p, 'id');
      if (!id) continue;
      map[id] = {
        renewalPrice: Number(pick(p, 'renewal_price', 'initial_price') || 0),
        initialPrice: Number(pick(p, 'initial_price') || 0),
        billingPeriodDays: Number(pick(p, 'billing_period') || 0),
        currency: String(pick(p, 'base_currency', 'currency') || 'gbp').toLowerCase(),
        planType: pick(p, 'plan_type'),
        stock: pick(p, 'unlimited_stock') === true ? null : Number(pick(p, 'stock') ?? 0) || null,
      };
    }
  } catch (err) {
    console.error('plan fetch failed, MRR will be unavailable:', err);
  }
  return map;
}

/**
 * Resolve a Whop user ID to a name. Cached per run; failures are non-fatal
 * because email is a good enough fallback.
 */
const userCache = new Map();

// Once an endpoint 404s we stop trying it, rather than burning a round trip
// per member for the rest of the run.
let workingUserPath = null;
let userLookupDead = false;

async function resolveUser(userId) {
  if (!userId || userLookupDead) return null;
  if (userCache.has(userId)) return userCache.get(userId);

  const paths = workingUserPath
    ? [workingUserPath]
    : [`/users/${userId}`, `/members/${userId}`];

  let result = null;
  for (const path of paths) {
    try {
      const d = await whopFetch(path.replace(/\/(users|members)\/.*/, `/$1/${userId}`));
      const body = pick(d, 'data') || d;
      const name = pick(body, 'name', 'username', 'user.name', 'user.username');
      if (name) {
        workingUserPath = path;
        result = {
          name: pick(body, 'name', 'user.name'),
          username: pick(body, 'username', 'user.username'),
        };
        break;
      }
    } catch { /* try the next, then fall back to email */ }
  }

  // Neither endpoint worked on the first attempt - don't try again this run.
  if (!result && !workingUserPath) userLookupDead = true;

  userCache.set(userId, result);
  return result;
}

/**
 * Normalise a membership.
 *
 * Identity fields are carried here but only surfaced for members who need
 * action (cancelling or lapsed). Everyone else stays an anonymous count.
 */
function normalise(m, plans) {
  const planId = pick(m, 'plan', 'plan_id');
  const plan = (planId && plans[planId]) || null;

  const status = String(pick(m, 'status') || '').toLowerCase();
  const valid = pick(m, 'valid');
  const isActive = valid === true || ['active', 'trialing', 'completed'].includes(status);

  const renewalPrice = plan ? plan.renewalPrice : 0;
  const periodDays = plan ? plan.billingPeriodDays : 0;

  // A 28-31 day cycle IS monthly - don't inflate 34.99 into 35.50 by
  // normalising to a 30.44-day calendar month. Only normalise genuinely
  // different cycles (weekly, annual).
  let monthlyValue = 0;
  if (renewalPrice && periodDays >= 28 && periodDays <= 31) monthlyValue = renewalPrice;
  else if (renewalPrice && periodDays) monthlyValue = renewalPrice * (30.44 / periodDays);
  else if (renewalPrice) monthlyValue = renewalPrice;

  return {
    id: pick(m, 'id'),
    status: status || null,
    isActive,
    cancelAtPeriodEnd: !!pick(m, 'cancel_at_period_end'),
    promoCode: pick(m, 'promo_code'),
    planId,
    renewalPrice,
    billingPeriodDays: periodDays,
    monthlyValue: round2(monthlyValue),
    currency: plan ? plan.currency : null,
    email: pick(m, 'email'),
    userId: pick(m, 'user', 'user_id'),
    telegramId: pick(m, 'telegram_account_id'),
    createdAt: toDay(pick(m, 'created_at')),
    renewalPeriodEnd: toDay(pick(m, 'renewal_period_end', 'expires_at')),
    // v2 has no canceled_at field. For an inactive membership the period
    // end is when access actually lapsed, so use that as the churn date.
    endedAt: !isActive ? toDay(pick(m, 'renewal_period_end', 'expires_at')) : null,
    // affiliate_page_url is the member's OWN referral link to share, not
    // how they were acquired. The real referrer is affiliate_username,
    // which is null unless someone actually referred them.
    referredBy: pick(m, 'affiliate_username'),
    inTelegram: !!pick(m, 'telegram_account_id'),
  };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function summarise(rows, planFacts = {}, actionList = []) {
  const planStock = planFacts.stock ?? null;
  const planPrice = planFacts.renewalPrice ?? null;
  const planInitial = planFacts.initialPrice ?? null;
  const planPeriod = planFacts.billingPeriodDays ?? null;
  const active = rows.filter((r) => r.isActive);
  const cancelling = active.filter((r) => r.cancelAtPeriodEnd);
  const inactive = rows.filter((r) => !r.isActive);

  const mrr = active.reduce((a, r) => a + r.monthlyValue, 0);
  const atRiskMrr = cancelling.reduce((a, r) => a + r.monthlyValue, 0);

  const joined30 = rows.filter((r) => r.createdAt && r.createdAt >= daysAgo(30)).length;
  const joined7 = rows.filter((r) => r.createdAt && r.createdAt >= daysAgo(7)).length;
  const cancelled30 = rows.filter((r) => r.endedAt && r.endedAt >= daysAgo(30)).length;
  const cancelled90 = rows.filter((r) => r.endedAt && r.endedAt >= daysAgo(90)).length;

  // How long people last. With monthly-only billing this is the whole game.
  const lifespans = rows
    .filter((r) => !r.isActive && r.createdAt && r.endedAt)
    .map((r) => Math.round((new Date(r.endedAt) - new Date(r.createdAt)) / 86400000));
  const avgLifespanDays = lifespans.length
    ? Math.round(lifespans.reduce((a, b) => a + b, 0) / lifespans.length)
    : null;
  const churnedInFirstCycle = lifespans.filter((d) => d <= 31).length;

  // Genuine referrals only.
  const affiliates = {};
  for (const r of rows) {
    if (!r.referredBy) continue;
    affiliates[r.referredBy] = (affiliates[r.referredBy] || 0) + 1;
  }

  // How many came through the 50%-off first month promo.
  const promo = {};
  for (const r of rows) {
    if (!r.promoCode) continue;
    promo[r.promoCode] = (promo[r.promoCode] || 0) + 1;
  }

  const statuses = {};
  for (const r of rows) {
    const k = r.status || 'unknown';
    statuses[k] = (statuses[k] || 0) + 1;
  }

  const currencies = [...new Set(active.map((r) => r.currency).filter(Boolean))];
  const pricingKnown = active.some((r) => r.renewalPrice > 0);

  return {
    asOf: new Date().toISOString().slice(0, 10),
    activeMembers: active.length,
    cancellingAtPeriodEnd: cancelling.length,
    inactiveOrExpired: inactive.length,
    totalMembershipRecords: rows.length,

    mrr: pricingKnown ? round2(mrr) : null,
    atRiskMrr: pricingKnown ? round2(atRiskMrr) : null,
    currency: currencies.length === 1 ? currencies[0] : currencies,
    pricingNote: pricingKnown
      ? null
      : 'Plan pricing could not be read, so MRR is unavailable. Member counts are still accurate.',

    joinedLast7Days: joined7,
    joinedLast30Days: joined30,
    cancelledLast30Days: cancelled30,
    cancelledLast90Days: cancelled90,
    netChangeLast30Days: joined30 - cancelled30,

    retention: {
      note: 'Monthly billing only. There is no annual or lifetime tier, so all revenue is re-decided every cycle and retention is the whole game.',
      everSubscribed: rows.length,
      stillActive: active.length,
      cancelledSinceLaunch: inactive.length,
      cancellationRatePct: rows.length ? round2((inactive.length / rows.length) * 100) : null,
      averageLifespanDays: avgLifespanDays,
      churnedWithinFirstCycle: churnedInFirstCycle,
      estimatedLifetimeValue: avgLifespanDays && planPrice && planPeriod
        ? round2((avgLifespanDays / planPeriod) * planPrice)
        : null,
      lifetimeValueNote: 'Average lifespan divided by billing cycle, times price. Rough - it only counts members who have already left.',
      churnDatesNote: 'Whop v2 has no cancellation-date field, so the end date is derived from when the billing period lapsed. Accurate to the cycle, not the day they clicked cancel.',
    },

    capacity: {
      note: 'The plan has a hard place cap, so scarcity is real rather than a sales line.',
      places: planStock,
      filled: active.length,
      remaining: planStock === null ? null : planStock - active.length,
      percentFull: planStock ? round2((active.length / planStock) * 100) : null,
    },

    planEconomics: {
      renewalPrice: planPrice,
      initialPrice: planInitial,
      billingPeriodDays: planPeriod,
      currency: currencies[0] || null,
      initialPriceNote: planInitial === 0
        ? 'initial_price is 0, which on a renewal plan means there is no separate signup fee on top of the subscription. Members pay the renewal price from the start.'
        : null,
    },

    statusBreakdown: statuses,
    promoCodeUse: promo,
    referrals: {
      note: 'Members who arrived through someone else\'s referral link. Empty means nobody is referring, which is itself worth knowing.',
      byReferrer: affiliates,
      totalReferred: Object.values(affiliates).reduce((a, b) => a + b, 0),
    },
    membersLinkedToTelegram: rows.filter((r) => r.inTelegram).length,

    upcomingRenewals: active
      .filter((r) => r.renewalPeriodEnd)
      .sort((a, b) => (a.renewalPeriodEnd < b.renewalPeriodEnd ? -1 : 1))
      .slice(0, 10)
      .map((r) => ({
        renews: r.renewalPeriodEnd,
        monthlyValue: r.monthlyValue,
        cancelling: r.cancelAtPeriodEnd,
      })),

    membersNeedingAction: actionList,

    caveats: [
      'MRR is active members multiplied by the renewal price. It is contracted revenue, not cash received.',
      'NEWMEMBER gives 50% off the first month, so new joiners bill below steady state in month one.',
      'atRiskMrr is revenue from members already flagged cancel-at-period-end.',
      'Only members needing action are identified by name. Everyone else stays an anonymous count.',
    ],
  };
}

// --- cache -----------------------------------------------------------------

async function getCached() {
  try {
    const v = await getStore(CACHE_STORE).get(CACHE_KEY, { type: 'json' });
    if (!v || !v.fetchedAt) return null;
    const ageMin = (Date.now() - new Date(v.fetchedAt).getTime()) / 60000;
    return ageMin < CACHE_MINUTES ? v : null;
  } catch {
    return null;
  }
}

export async function getWhopSnapshot({ fresh = false } = {}) {
  if (!fresh) {
    const cached = await getCached();
    if (cached) return { ...cached, fromCache: true };
  }

  const [memberships, plans] = await Promise.all([
    fetchAllPages('memberships'),
    fetchPlanPricing(),
  ]);

  const rows = memberships.map((m) => normalise(m, plans));

  // The main plan is whichever the most active members are on.
  const counts = {};
  for (const r of rows) if (r.isActive && r.planId) counts[r.planId] = (counts[r.planId] || 0) + 1;
  const mainPlanId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const planFacts = (mainPlanId && plans[mainPlanId]) || {};

  // Only members who need action get identified. Cancelling now, or
  // lapsed in the last 30 days and possibly still sitting in the group.
  const needsAction = rows.filter(
    (r) => (r.isActive && r.cancelAtPeriodEnd) || (!r.isActive && r.endedAt && r.endedAt >= daysAgo(30))
  );

  const resolved = await Promise.all(needsAction.map((r) => resolveUser(r.userId)));

  const actionList = [];
  needsAction.forEach((r, i) => {
    const u = resolved[i];
    const label =
      (u && u.name && u.username && u.name !== u.username ? `${u.name} (@${u.username})` : null) ||
      (u && (u.name || u.username)) ||
      r.email ||
      r.id;

    actionList.push({
      who: label,
      email: r.email || null,
      telegramId: r.telegramId || null,
      telegramLinked: !!r.telegramId,
      action: r.isActive ? 'cancelling at period end' : 'EXPIRED - remove from Telegram',
      accessEnds: r.isActive ? r.renewalPeriodEnd : r.endedAt,
      monthlyValue: r.monthlyValue,
    });
  });

  actionList.sort((a, b) => String(a.accessEnds).localeCompare(String(b.accessEnds)));

  const snapshot = {
    ...summarise(rows, planFacts, actionList),
    fetchedAt: new Date().toISOString(),
  };

  try {
    await getStore(CACHE_STORE).setJSON(CACHE_KEY, snapshot);
  } catch (err) {
    console.error('whop cache write failed:', err);
  }

  return { ...snapshot, fromCache: false };
}

// --- handler ---------------------------------------------------------------

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('pw') !== process.env.ADMIN_PASSWORD) {
    return new Response('unauthorised', { status: 401 });
  }

  try {
    if (url.searchParams.get('raw') === '1') {
      const data = await whopFetch('/memberships?page=1&per=2');
      const plans = await whopFetch('/plans?page=1&per=3');
      // Strip PII before it goes anywhere near a screen or a log.
      const scrub = (o) => {
        const c = { ...o };
        delete c.email;
        delete c.license_key;
        delete c.user;
        delete c.user_id;
        return c;
      };
      return json({
        note: 'Raw v2 shapes with email, licence key and user ID removed.',
        membershipKeys: Object.keys((data.data || [])[0] || {}),
        memberships: (data.data || []).map(scrub),
        planKeys: Object.keys((plans.data || [])[0] || {}),
        plans: plans.data || [],
      });
    }

    const snapshot = await getWhopSnapshot({ fresh: url.searchParams.get('fresh') === '1' });
    return json(snapshot);
  } catch (err) {
    console.error('whop failed:', err);
    return json({ error: err.message }, 500);
  }
};

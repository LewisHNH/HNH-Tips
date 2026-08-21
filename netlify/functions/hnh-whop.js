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
      };
    }
  } catch (err) {
    console.error('plan fetch failed, MRR will be unavailable:', err);
  }
  return map;
}

/**
 * Normalise a membership. Email and licence key are deliberately dropped.
 */
function normalise(m, plans) {
  const planId = pick(m, 'plan', 'plan_id');
  const plan = (planId && plans[planId]) || null;

  const status = String(pick(m, 'status') || '').toLowerCase();
  const valid = pick(m, 'valid');
  const isActive = valid === true || ['active', 'trialing', 'completed'].includes(status);

  const renewalPrice = plan ? plan.renewalPrice : 0;
  const periodDays = plan ? plan.billingPeriodDays : 0;

  // Monthly equivalent so weekly/annual plans are comparable.
  let monthlyValue = 0;
  if (renewalPrice && periodDays) monthlyValue = renewalPrice * (30.44 / periodDays);
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
    createdAt: toDay(pick(m, 'created_at')),
    renewalPeriodEnd: toDay(pick(m, 'renewal_period_end', 'expires_at')),
    canceledAt: toDay(pick(m, 'canceled_at', 'cancelled_at')),
  };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function summarise(rows) {
  const active = rows.filter((r) => r.isActive);
  const cancelling = active.filter((r) => r.cancelAtPeriodEnd);
  const inactive = rows.filter((r) => !r.isActive);

  const mrr = active.reduce((a, r) => a + r.monthlyValue, 0);
  const atRiskMrr = cancelling.reduce((a, r) => a + r.monthlyValue, 0);

  const joined30 = rows.filter((r) => r.createdAt && r.createdAt >= daysAgo(30)).length;
  const joined7 = rows.filter((r) => r.createdAt && r.createdAt >= daysAgo(7)).length;
  const cancelled30 = rows.filter((r) => r.canceledAt && r.canceledAt >= daysAgo(30)).length;

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
    netChangeLast30Days: joined30 - cancelled30,

    statusBreakdown: statuses,
    promoCodeUse: promo,

    upcomingRenewals: active
      .filter((r) => r.renewalPeriodEnd)
      .sort((a, b) => (a.renewalPeriodEnd < b.renewalPeriodEnd ? -1 : 1))
      .slice(0, 10)
      .map((r) => ({
        renews: r.renewalPeriodEnd,
        monthlyValue: r.monthlyValue,
        cancelling: r.cancelAtPeriodEnd,
      })),

    caveats: [
      'MRR is the monthly equivalent of current renewal prices, not cash received.',
      'NEWMEMBER gives 50% off the first month, so new joiners bill below steady state in month one.',
      'atRiskMrr is revenue from members already flagged cancel-at-period-end.',
      'Customer emails are deliberately not collected here.',
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
  const snapshot = { ...summarise(rows), fetchedAt: new Date().toISOString() };

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

// netlify/functions/hnh-whop.js
//
// Reads the Exclusive Group's membership and revenue picture from Whop.
//
// Env vars needed:
//   WHOP_API_KEY      company API key (Whop dashboard -> Developer -> API keys)
//   WHOP_COMPANY_ID   biz_xxxxx (required when authenticating with an API key)
//
// Usage:
//   /.netlify/functions/hnh-whop?pw=PASSWORD           computed summary
//   /.netlify/functions/hnh-whop?pw=PASSWORD&raw=1     raw shape, for debugging
//   /.netlify/functions/hnh-whop?pw=PASSWORD&fresh=1   bypass the 15-min cache
//
// The raw mode exists so field names can be confirmed against the real
// response rather than assumed.

import { getStore } from '@netlify/blobs';

const CACHE_STORE = 'hnh-events';
const CACHE_KEY = 'cache/whop-snapshot';
const CACHE_MINUTES = 15;

const API = 'https://api.whop.com/api/v1';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Field names vary across API versions, so try several rather than assume one.
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

async function whopFetch(path) {
  const key = process.env.WHOP_API_KEY;
  if (!key) throw new Error('WHOP_API_KEY is not set');

  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Whop returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Whop ${res.status}: ${pick(data, 'error.message', 'message', 'error') || text.slice(0, 200)}`);
  }
  return data;
}

/**
 * Pull every membership, following cursor pagination.
 * Guarded at 20 pages so a pagination bug can't loop forever.
 */
async function fetchAllMemberships() {
  const companyId = process.env.WHOP_COMPANY_ID;
  const all = [];
  let after = null;
  let pages = 0;

  while (pages < 20) {
    const params = new URLSearchParams();
    if (companyId) params.set('company_id', companyId);
    params.set('first', '100');
    if (after) params.set('after', after);

    const data = await whopFetch(`/memberships?${params.toString()}`);

    // Response shape differs between versions - handle the common ones.
    const batch =
      (Array.isArray(data) && data) ||
      pick(data, 'data') ||
      pick(data, 'memberships') ||
      pick(data, 'nodes') ||
      [];

    const list = Array.isArray(batch) ? batch : [];
    all.push(...list);

    const hasNext = pick(data, 'page_info.has_next_page', 'pageInfo.hasNextPage');
    const endCursor = pick(data, 'page_info.end_cursor', 'pageInfo.endCursor');
    if (!hasNext || !endCursor || !list.length) break;
    after = endCursor;
    pages++;
  }

  return all;
}

/**
 * Normalise one membership into the fields we actually care about.
 */
function normalise(m) {
  const status = String(pick(m, 'status', 'membership_status') || '').toLowerCase();
  const valid = pick(m, 'valid');

  const renewalPrice = Number(
    pick(m, 'plan.renewal_price', 'plan.renewalPrice', 'renewal_price', 'plan.initial_price') || 0
  );
  const billingPeriodDays = Number(
    pick(m, 'plan.billing_period', 'plan.billingPeriod', 'billing_period') || 0
  );
  const currency = pick(m, 'plan.base_currency', 'currency', 'plan.currency') || 'gbp';

  const cancelAtPeriodEnd = !!pick(m, 'cancel_at_period_end', 'cancelAtPeriodEnd');
  const canceledAt = pick(m, 'canceled_at', 'canceledAt', 'cancelled_at');

  // Monthly-equivalent revenue, so weekly/annual plans are comparable.
  let monthlyValue = 0;
  if (renewalPrice && billingPeriodDays) {
    monthlyValue = renewalPrice * (30.44 / billingPeriodDays);
  } else if (renewalPrice) {
    monthlyValue = renewalPrice; // assume monthly if period unknown
  }

  const isActive =
    valid === true ||
    ['active', 'completed', 'trialing', 'valid'].includes(status);

  return {
    id: pick(m, 'id'),
    status: status || null,
    isActive,
    cancelAtPeriodEnd,
    canceledAt: canceledAt ? new Date(Number(canceledAt) * 1000).toISOString().slice(0, 10) : null,
    cancelReasonCategory: pick(m, 'cancel_reason_category', 'cancellation_reason', 'cancelReasonCategory'),
    cancelReasonText: pick(m, 'cancel_reason', 'cancellation_reason_text'),
    renewalPrice,
    billingPeriodDays,
    monthlyValue: round2(monthlyValue),
    currency: String(currency).toLowerCase(),
    createdAt: (() => {
      const c = pick(m, 'created_at', 'createdAt');
      return c ? new Date(Number(c) * 1000).toISOString().slice(0, 10) : null;
    })(),
    renewalPeriodEnd: (() => {
      const r = pick(m, 'renewal_period_end', 'renewalPeriodEnd', 'expires_at');
      return r ? new Date(Number(r) * 1000).toISOString().slice(0, 10) : null;
    })(),
  };
}

function summarise(memberships) {
  const rows = memberships.map(normalise);
  const active = rows.filter((r) => r.isActive);
  const cancelling = active.filter((r) => r.cancelAtPeriodEnd);
  const churned = rows.filter((r) => !r.isActive);

  const mrr = active.reduce((a, r) => a + r.monthlyValue, 0);
  const atRiskMrr = cancelling.reduce((a, r) => a + r.monthlyValue, 0);

  // Why people leave. The single most actionable number here.
  const reasons = {};
  for (const r of [...cancelling, ...churned]) {
    const key = r.cancelReasonCategory || 'not given';
    reasons[key] = (reasons[key] || 0) + 1;
  }

  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const joinedLast30 = rows.filter((r) => r.createdAt && r.createdAt >= daysAgo(30)).length;
  const cancelledLast30 = rows.filter((r) => r.canceledAt && r.canceledAt >= daysAgo(30)).length;

  const currencies = [...new Set(active.map((r) => r.currency))];

  return {
    asOf: today,
    activeMembers: active.length,
    cancellingAtPeriodEnd: cancelling.length,
    churnedTotal: churned.length,
    mrr: round2(mrr),
    atRiskMrr: round2(atRiskMrr),
    currency: currencies.length === 1 ? currencies[0] : currencies,
    last30Days: {
      joined: joinedLast30,
      cancelled: cancelledLast30,
      netChange: joinedLast30 - cancelledLast30,
    },
    cancellationReasons: reasons,
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
      'MRR is the monthly-equivalent of current renewal prices, not cash received.',
      'The NEWMEMBER promo gives 50% off the first month, so new joiners bill below their steady-state value in month one.',
      'atRiskMrr is revenue from members who have already flagged cancel-at-period-end.',
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

async function setCached(snapshot) {
  try {
    await getStore(CACHE_STORE).setJSON(CACHE_KEY, snapshot);
  } catch (err) {
    console.error('whop cache write failed:', err);
  }
}

export async function getWhopSnapshot({ fresh = false } = {}) {
  if (!fresh) {
    const cached = await getCached();
    if (cached) return { ...cached, fromCache: true };
  }
  const memberships = await fetchAllMemberships();
  const snapshot = {
    ...summarise(memberships),
    totalMembershipsSeen: memberships.length,
    fetchedAt: new Date().toISOString(),
  };
  await setCached(snapshot);
  return { ...snapshot, fromCache: false };
}

// --- handler ---------------------------------------------------------------

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('pw') !== process.env.ADMIN_PASSWORD) {
    return new Response('unauthorised', { status: 401 });
  }

  try {
    // Debug mode: show the real response shape so field mapping can be
    // confirmed rather than guessed.
    if (url.searchParams.get('raw') === '1') {
      const companyId = process.env.WHOP_COMPANY_ID;
      const params = new URLSearchParams();
      if (companyId) params.set('company_id', companyId);
      params.set('first', '2');
      const data = await whopFetch(`/memberships?${params.toString()}`);
      return json({
        note: 'Raw Whop response, first 2 memberships. Used to confirm field names.',
        topLevelKeys: Object.keys(data || {}),
        raw: data,
      });
    }

    const snapshot = await getWhopSnapshot({
      fresh: url.searchParams.get('fresh') === '1',
    });
    return json(snapshot);
  } catch (err) {
    console.error('whop failed:', err);
    return json({ error: err.message }, 500);
  }
};

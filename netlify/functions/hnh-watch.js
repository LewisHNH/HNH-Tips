// netlify/functions/hnh-watch.js
//
// Watches the Exclusive Group for membership changes and alerts you in
// Telegram. Runs hourly; each run diffs against the previous snapshot.
//
// Alerts on:
//   - someone flags cancel-at-period-end (you get warning before they go)
//   - a membership actually lapses (time to remove them from the group)
//   - someone new joins
//   - anyone expiring in the next 3 days
//
// netlify.toml:
//   [functions."hnh-watch"]
//     schedule = "0 * * * *"
//
// Manual test:
//   /.netlify/functions/hnh-watch?pw=PASSWORD&force=1

import { getStore } from '@netlify/blobs';

const STATE_STORE = 'hnh-events';
const STATE_KEY = 'watch/whop-state';
const API = 'https://api.whop.com/api/v2';

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

const toDay = (u) => (u ? new Date(Number(u) * 1000).toISOString().slice(0, 10) : null);

async function whopFetch(path) {
  const key = process.env.WHOP_API_KEY;
  if (!key) throw new Error('WHOP_API_KEY is not set');
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Whop non-JSON (${res.status}): ${text.slice(0, 150)}`);
  }
  if (!res.ok) throw new Error(`Whop ${res.status}: ${pick(data, 'error.message') || 'failed'}`);
  return data;
}

async function fetchMemberships() {
  const all = [];
  let page = 1, totalPages = 1;
  while (page <= totalPages && page <= 30) {
    const data = await whopFetch(`/memberships?page=${page}&per=50`);
    all.push(...(pick(data, 'data') || []));
    totalPages = Number(pick(data, 'pagination.total_page', 'pagination.total_pages')) || 1;
    page++;
  }
  return all;
}

/**
 * Resolve a user ID to a name. Whop returns only an ID on the membership,
 * so this fills in who the person actually is. Cached per run, and failures
 * are non-fatal since email is a good enough fallback.
 */
const userCache = new Map();

async function resolveUser(userId) {
  if (!userId) return null;
  if (userCache.has(userId)) return userCache.get(userId);

  let result = null;
  for (const path of [`/users/${userId}`, `/members/${userId}`]) {
    try {
      const d = await whopFetch(path);
      const body = pick(d, 'data') || d;
      const name = pick(body, 'name', 'username', 'user.name', 'user.username');
      if (name) {
        result = {
          name: pick(body, 'name', 'user.name'),
          username: pick(body, 'username', 'user.username'),
        };
        break;
      }
    } catch { /* endpoint may not exist on this key - fall back to email */ }
  }

  userCache.set(userId, result);
  return result;
}

/**
 * Fields needed to spot a change, plus enough to identify the person.
 *
 * PRIVACY NOTE: email is kept here because this data goes only to Lewis's
 * private Telegram channel so he can work out who to remove from the paid
 * group. It is NOT part of what the brain sends to the LLM.
 */
function snapshot(memberships) {
  const out = {};
  for (const m of memberships) {
    const id = pick(m, 'id');
    if (!id) continue;
    const status = String(pick(m, 'status') || '').toLowerCase();
    const valid = pick(m, 'valid');
    out[id] = {
      status,
      isActive: valid === true || ['active', 'trialing', 'completed'].includes(status),
      cancelAtPeriodEnd: !!pick(m, 'cancel_at_period_end'),
      periodEnd: toDay(pick(m, 'renewal_period_end', 'expires_at')),
      telegramId: pick(m, 'telegram_account_id'),
      email: pick(m, 'email'),
      userId: pick(m, 'user', 'user_id'),
      joined: toDay(pick(m, 'created_at')),
    };
  }
  return out;
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

function shortId(id) {
  return String(id).replace(/^mem_/, '');
}

function describe(id, m) {
  const bits = [];

  // Best available human identifier, in order of usefulness.
  const label =
    (m.name && m.username && m.name !== m.username ? `${m.name} (@${m.username})` : null) ||
    m.name ||
    (m.username ? `@${m.username}` : null) ||
    m.email ||
    shortId(id);
  bits.push(`<b>${esc(label)}</b>`);

  if (m.email && label !== m.email) bits.push(esc(m.email));
  bits.push(
    m.telegramId
      ? `TG <code>${esc(m.telegramId)}</code>`
      : 'no Telegram linked - match by name'
  );
  return bits.join(' · ');
}

function daysUntil(isoDate) {
  if (!isoDate) return null;
  const diff = new Date(`${isoDate}T12:00:00Z`) - new Date();
  return Math.round(diff / 86400000);
}

async function buildAlert(prev, curr) {
  const lines = [];
  const newlyCancelling = [];
  const newlyLapsed = [];
  const newlyJoined = [];

  // Anything ending within 3 days that hasn't lapsed yet.
  const endingSoon = Object.entries(curr).filter(([, m]) => {
    if (!m.isActive || !m.cancelAtPeriodEnd) return false;
    const d = daysUntil(m.periodEnd);
    return d !== null && d >= 0 && d <= 3;
  });

  for (const [id, now] of Object.entries(curr)) {
    const before = prev[id];

    if (!before) {
      if (now.isActive) newlyJoined.push([id, now]);
      continue;
    }

    // Flagged to cancel, having previously not been.
    if (now.cancelAtPeriodEnd && !before.cancelAtPeriodEnd) {
      newlyCancelling.push([id, now]);
    }

    // Was active, now isn't. This is the one that means "remove them".
    if (before.isActive && !now.isActive) {
      newlyLapsed.push([id, now]);
    }
  }

  // Resolve names only for people who appear in the alert, not all 25.
  const needNames = [...newlyLapsed, ...newlyCancelling, ...endingSoon, ...newlyJoined];
  for (const [, m] of needNames) {
    const u = await resolveUser(m.userId);
    if (u) { m.name = u.name; m.username = u.username; }
  }

  if (newlyLapsed.length) {
    lines.push('<b>⚠️ EXPIRED — REMOVE FROM TELEGRAM NOW</b>');
    for (const [id, m] of newlyLapsed) {
      lines.push(`• ${describe(id, m)}`);
      if (m.periodEnd) lines.push(`  <i>access ended ${esc(m.periodEnd)}</i>`);
    }
    lines.push('');
  }

  if (newlyCancelling.length) {
    lines.push('<b>Cancelling at period end</b>');
    for (const [id, m] of newlyCancelling) {
      const d = daysUntil(m.periodEnd);
      const when = m.periodEnd ? `${m.periodEnd}${d !== null ? ` (${d}d)` : ''}` : 'date unknown';
      lines.push(`• ${describe(id, m)}`);
      lines.push(`  <i>remove them on ${esc(when)}</i>`);
    }
    lines.push('');
  }

  if (endingSoon.length) {
    lines.push('<b>Access ending within 3 days</b>');
    for (const [id, m] of endingSoon) {
      lines.push(`• ${describe(id, m)} — ${esc(m.periodEnd)}`);
    }
    lines.push('');
  }

  if (newlyJoined.length) {
    lines.push('<b>✅ New members</b>');
    for (const [id, m] of newlyJoined) lines.push(`• ${describe(id, m)}`);
    lines.push('');
  }

  if (!lines.length) return null;

  const active = Object.values(curr).filter((m) => m.isActive).length;
  lines.push(`<i>${active} active members</i>`);

  return lines.join('\n');
}

export default async (req) => {
  const url = new URL(req.url || 'https://x/');
  const forced = url.searchParams.get('force') === '1';

  if (forced && url.searchParams.get('pw') !== process.env.ADMIN_PASSWORD) {
    return new Response('unauthorised', { status: 401 });
  }

  try {
    const store = getStore(STATE_STORE);
    const memberships = await fetchMemberships();
    const curr = snapshot(memberships);

    let prev = null;
    try {
      prev = await store.get(STATE_KEY, { type: 'json' });
    } catch { /* first run */ }

    // Always save the new state, even if nothing is sent.
    await store.setJSON(STATE_KEY, curr);

    // First ever run has nothing to compare against. Save and stay quiet,
    // otherwise every existing member would be reported as new.
    if (!prev || typeof prev !== 'object') {
      return new Response(
        `baseline saved: ${Object.keys(curr).length} memberships, no alert on first run`,
        { status: 200 }
      );
    }

    const alert = await buildAlert(prev, curr);
    if (!alert) return new Response('no changes', { status: 200 });

    const chatId = process.env.BRIEF_CHAT_ID;
    if (!chatId) throw new Error('BRIEF_CHAT_ID is not set');

    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: alert,
      disable_web_page_preview: true,
    });

    return new Response('alert sent', { status: 200 });
  } catch (err) {
    console.error('watch failed:', err);
    return new Response(`watch failed: ${err.message}`, { status: 500 });
  }
};

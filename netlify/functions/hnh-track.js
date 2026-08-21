// netlify/functions/hnh-track.js
//
// Funnel tracking. Records what happens between someone seeing your content
// and someone paying you - currently the biggest blind spot in the business.
//
// Fires from the site with no auth (it's a public beacon), but only accepts
// a fixed list of event names so it can't be filled with junk.
//
// FROM THE SITE - add this once, before </body>:
//
//   <script>
//   (function(){
//     var p = new URLSearchParams(location.search);
//     function hit(ev, extra){
//       var b = Object.assign({
//         event: ev,
//         path: location.pathname,
//         ref: document.referrer || null,
//         utm_source: p.get('utm_source'),
//         utm_medium: p.get('utm_medium'),
//         utm_campaign: p.get('utm_campaign')
//       }, extra || {});
//       navigator.sendBeacon('/.netlify/functions/hnh-track', JSON.stringify(b));
//     }
//     hit('page_view');
//     document.addEventListener('click', function(e){
//       var a = e.target.closest('a');
//       if (!a) return;
//       var h = a.href || '';
//       if (h.indexOf('whop.com') > -1) hit('checkout_click');
//       else if (h.indexOf('t.me') > -1) hit('telegram_click', { target: h });
//     });
//   })();
//   </script>
//
// READ IT BACK:
//   /.netlify/functions/hnh-track?pw=PASSWORD&days=30

import { getStore } from '@netlify/blobs';

const STORE = 'hnh-events';

// Fixed list. Anything else is rejected, so a stray script can't pollute it.
const ALLOWED = [
  'page_view',
  'checkout_click',   // clicked through to Whop
  'telegram_click',   // clicked a Telegram invite
  'tips_view',        // looked at the tips page
  'results_view',     // looked at the results archive
  'email_signup',
];

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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * One blob per day of counters. Counters not raw hits, so this stays small
 * and fast no matter how much traffic the site gets.
 */
async function record(body) {
  const event = String(body.event || '').toLowerCase();
  if (!ALLOWED.includes(event)) return { ok: false, reason: 'unknown event' };

  const store = getStore(STORE);
  const day = ukDate();
  const key = `funnel/${day}`;

  let data;
  try {
    data = await store.get(key, { type: 'json' });
  } catch { /* first hit of the day */ }
  if (!data || typeof data !== 'object') data = { date: day, events: {}, sources: {}, paths: {} };

  data.events[event] = (data.events[event] || 0) + 1;

  // Where they came from. utm_source if tagged, else the referring domain.
  let source = body.utm_source || null;
  if (!source && body.ref) {
    try { source = new URL(body.ref).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  }
  if (source) {
    if (!data.sources[source]) data.sources[source] = {};
    data.sources[source][event] = (data.sources[source][event] || 0) + 1;
  }

  if (event === 'page_view' && body.path) {
    const p = String(body.path).slice(0, 80);
    data.paths[p] = (data.paths[p] || 0) + 1;
  }

  await store.setJSON(key, data);
  return { ok: true };
}

async function summarise(days) {
  const store = getStore(STORE);
  const today = ukDate();
  const start = addDays(today, -(days - 1));

  const dates = [];
  let cursor = start;
  while (cursor <= today) { dates.push(cursor); cursor = addDays(cursor, 1); }

  const daily = await Promise.all(
    dates.map(async (d) => {
      try {
        const v = await store.get(`funnel/${d}`, { type: 'json' });
        return v || null;
      } catch { return null; }
    })
  );

  const totals = {};
  const sources = {};
  const paths = {};

  for (const d of daily) {
    if (!d) continue;
    for (const [k, v] of Object.entries(d.events || {})) totals[k] = (totals[k] || 0) + v;
    for (const [src, evs] of Object.entries(d.sources || {})) {
      if (!sources[src]) sources[src] = {};
      for (const [k, v] of Object.entries(evs)) sources[src][k] = (sources[src][k] || 0) + v;
    }
    for (const [p, v] of Object.entries(d.paths || {})) paths[p] = (paths[p] || 0) + v;
  }

  const views = totals.page_view || 0;
  const checkout = totals.checkout_click || 0;
  const telegram = totals.telegram_click || 0;

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

  return {
    windowDays: days,
    from: start,
    to: today,
    dataPresent: Object.keys(totals).length > 0,
    totals,
    funnel: {
      pageViews: views,
      telegramClicks: telegram,
      checkoutClicks: checkout,
      viewToCheckoutPct: pct(checkout, views),
      viewToTelegramPct: pct(telegram, views),
      note: 'Checkout clicks are people who reached Whop, not people who paid. Compare against actual new members to get the true conversion.',
    },
    bySource: Object.entries(sources)
      .map(([source, evs]) => ({
        source,
        pageViews: evs.page_view || 0,
        checkoutClicks: evs.checkout_click || 0,
        telegramClicks: evs.telegram_click || 0,
        checkoutRatePct: pct(evs.checkout_click || 0, evs.page_view || 0),
      }))
      .sort((a, b) => b.pageViews - a.pageViews)
      .slice(0, 15),
    topPaths: Object.entries(paths)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({ path, count })),
  };
}

export default async (req) => {
  // Writes are public - it's a beacon from the site. Reads need the password.
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const result = await record(body);
      return json(result, result.ok ? 200 : 400);
    } catch (err) {
      console.error('track write failed:', err);
      return json({ ok: false }, 400);
    }
  }

  const url = new URL(req.url);
  if (url.searchParams.get('pw') !== process.env.ADMIN_PASSWORD) {
    return new Response('unauthorised', { status: 401 });
  }

  const days = Math.min(parseInt(url.searchParams.get('days'), 10) || 30, 180);
  try {
    return json(await summarise(days));
  } catch (err) {
    console.error('track read failed:', err);
    return json({ error: err.message }, 500);
  }
};

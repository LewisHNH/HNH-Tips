// netlify/functions/hnh-scheduler.js
//
// Sends queued broadcasts when they come due. Runs every five minutes.
//
// netlify.toml:
//   [functions."hnh-scheduler"]
//     schedule = "*/5 * * * *"
//
// Manual: /.netlify/functions/hnh-scheduler?pw=PASSWORD
//
// Five minutes is deliberate. A tighter schedule would burn function
// invocations for no benefit - nothing here is second-critical, and a post
// landing at 18:02 instead of 18:00 costs nothing.

import { getStore } from '@netlify/blobs';

const EVENTS_STORE = 'hnh-events';
const QUEUE_KEY = 'queue/scheduled';

const CHANNEL_ENV = {
  main: 'TELEGRAM_MAIN_CHAT_ID',
  horses: 'TELEGRAM_HORSE_CHAT_ID',
  greyhounds: 'TELEGRAM_GREYHOUND_CHAT_ID',
  exclusive: 'TELEGRAM_EXCLUSIVE_CHAT_ID',
};

async function tg(method, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.BRAIN_BOT_TOKEN}/${method}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return res.json();
}

export default async (req) => {
  const url = new URL(req.url || 'https://x/');
  const manual = url.searchParams.has('pw');
  if (manual && url.searchParams.get('pw') !== process.env.ADMIN_PASSWORD) {
    return new Response('unauthorised', { status: 401 });
  }

  try {
    const store = getStore(EVENTS_STORE);
    let queue = [];
    try {
      const v = await store.get(QUEUE_KEY, { type: 'json' });
      if (Array.isArray(v)) queue = v;
    } catch { /* nothing queued */ }

    const now = Date.now();
    const due = queue.filter(
      (i) => i.status === 'queued' && new Date(i.when).getTime() <= now
    );

    if (!due.length) {
      // Housekeeping: drop anything sent or cancelled over 30 days ago so
      // the queue blob doesn't grow forever.
      const cutoff = now - 30 * 86400000;
      const pruned = queue.filter(
        (i) => i.status === 'queued' || new Date(i.when).getTime() > cutoff
      );
      if (pruned.length !== queue.length) await store.setJSON(QUEUE_KEY, pruned);
      return new Response('nothing due', { status: 200 });
    }

    const results = [];
    for (const item of due) {
      const chatId = process.env[CHANNEL_ENV[item.channel]];
      if (!chatId) {
        item.status = 'failed';
        item.error = `${item.channel} not configured`;
        results.push(`${item.id}: not configured`);
        continue;
      }

      try {
        const sent = await tg('sendMessage', {
          chat_id: chatId,
          text: item.message,
          disable_web_page_preview: true,
        });
        if (!sent.ok) throw new Error(sent.description);
        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        results.push(`${item.id}: sent to ${item.channel}`);
      } catch (err) {
        // Leave it queued so the next run retries, unless it has failed
        // repeatedly - a permanent failure shouldn't retry forever.
        item.attempts = (item.attempts || 0) + 1;
        item.error = err.message;
        if (item.attempts >= 3) {
          item.status = 'failed';
          results.push(`${item.id}: failed after 3 attempts - ${err.message}`);
        } else {
          results.push(`${item.id}: attempt ${item.attempts} failed, will retry`);
        }
      }
    }

    await store.setJSON(QUEUE_KEY, queue);

    // Tell Lewis about anything that failed. Silence on success - a
    // notification for every scheduled post would be noise.
    const failures = due.filter((i) => i.status === 'failed');
    if (failures.length && process.env.BRIEF_CHAT_ID) {
      await tg('sendMessage', {
        chat_id: process.env.BRIEF_CHAT_ID,
        parse_mode: 'HTML',
        text: [
          '<b>Scheduled post failed</b>',
          '',
          ...failures.map((f) => `• ${f.channel}: ${f.error}`),
        ].join('\n'),
      }).catch(() => {});
    }

    console.log('scheduler:', results.join(' | '));
    return new Response(results.join('\n'), { status: 200 });
  } catch (err) {
    console.error('scheduler failed:', err);
    return new Response(`scheduler failed: ${err.message}`, { status: 500 });
  }
};

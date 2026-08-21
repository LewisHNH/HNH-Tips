// netlify/functions/hnh-brain-background.js
//
// The thinking half of the brain. Netlify functions ending in "-background"
// return 202 immediately and then run for up to 15 minutes, which is what
// this needs: Claude takes 10-20 seconds to write a content plan, and a
// normal function is killed at 10.
//
// hnh-webhook validates the message and hands off here, so Telegram always
// gets its 200 straight away and never retries.
//
// Not called directly - invoked by hnh-webhook.

import { getStore } from '@netlify/blobs';

const EVENTS_STORE = 'hnh-events';

async function tg(method, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.BRAIN_BOT_TOKEN}/${method}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return res.json();
}

export default async (req) => {
  let job;
  try {
    job = await req.json();
  } catch {
    return new Response('bad payload', { status: 202 });
  }

  const { chatId, text, seenKey, secret } = job || {};

  // This endpoint is public, so require a shared secret before it will do
  // anything. Without it, anyone could make the bot talk.
  if (!secret || secret !== process.env.ADMIN_PASSWORD) {
    console.error('background: bad or missing secret');
    return new Response('unauthorised', { status: 202 });
  }
  if (!chatId || !text) return new Response('nothing to do', { status: 202 });

  const store = getStore(EVENTS_STORE);
  const started = Date.now();

  try {
    // Keep the typing indicator alive while Claude works. Telegram clears
    // it after about 5 seconds, so refresh it a few times.
    const keepTyping = setInterval(() => {
      tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    }, 4000);
    tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    // The brain's own logic lives in hnh-webhook, so call it in "think"
    // mode rather than duplicating several hundred lines across two files.
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
    const res = await fetch(`${base}/.netlify/functions/hnh-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hnh-think': process.env.ADMIN_PASSWORD },
      body: JSON.stringify({ think: true, text }),
    });

    clearInterval(keepTyping);

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: data.html,
      disable_web_page_preview: true,
    });

    console.log(`background done in ${Date.now() - started}ms`);
    if (seenKey) await store.setJSON(seenKey, { status: 'done', at: new Date().toISOString() });
  } catch (err) {
    console.error(`background failed after ${Date.now() - started}ms:`, err);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Couldn't answer that: ${err.message}`,
    }).catch(() => {});
    if (seenKey) {
      await store
        .setJSON(seenKey, { status: 'done', at: new Date().toISOString() })
        .catch(() => {});
    }
  }

  return new Response('ok', { status: 202 });
};

// netlify/functions/lib/telegram.js
// Thin wrapper over the Bot API. Used by the BRAIN bot only.
// Your existing @hoovesnhounds_bot keeps its own token and its own code.

const API = 'https://api.telegram.org/bot';

function token() {
  const t = process.env.BRAIN_BOT_TOKEN;
  if (!t) throw new Error('BRAIN_BOT_TOKEN is not set');
  return t;
}

// parse_mode HTML needs these three escaped. Much less painful than MarkdownV2.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function call(method, body) {
  const res = await fetch(`${API}${token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`telegram ${method} failed: ${data.description}`);
  }
  return data.result;
}

async function sendMessage(chatId, text, opts = {}) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...opts,
  });
}

async function sendChatAction(chatId, action = 'typing') {
  return call('sendChatAction', { chat_id: chatId, action });
}

module.exports = { call, sendMessage, sendChatAction, esc };

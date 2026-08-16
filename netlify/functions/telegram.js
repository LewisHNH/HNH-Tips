// Posts free greyhound tips and results to a Telegram channel.
// Fire-and-forget by design: if Telegram is down, the tip still saves.

const API = 'https://api.telegram.org/bot';

// Set SITE_GREYHOUNDS_URL in Netlify to override; this is the fallback.
const LINK = process.env.SITE_GREYHOUNDS_URL || 'https://tips.hoovesnhounds.com/#greyhounds';

const esc = (s) =>
  String(s ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

function fmtPts(n) {
  const v = Number(n) || 0;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
}

function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

async function send(text, disablePreview = false) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GREYHOUND_CHAT_ID;
  if (!token || !chatId) return { skipped: 'Telegram not configured' };

  try {
    const res = await fetch(`${API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: disablePreview,
      }),
    });
    const data = await res.json();
    return data.ok ? { sent: true } : { error: data.description || 'Telegram rejected the message' };
  } catch (error) {
    return { error: error.message };
  }
}

/** Announce a new selection. */
export function announceTip(tip) {
  const pts = Number(tip.points) || 1;
  const lines = [
    '🐕 <b>FREE TRAP OF THE DAY</b>',
    '',
    `<b>${esc(tip.dog)}</b>`,
    `Trap ${tip.trap} · ${esc(tip.track)} ${esc(tip.time)}`,
    `${esc(tip.oddsAdvised || '')}${tip.book ? ` (${esc(tip.book)})` : ''} · ${pts} pt${pts === 1 ? '' : 's'}`,
  ];
  if (tip.notes) lines.push('', `<i>${esc(tip.notes)}</i>`);
  lines.push(
    '',
    `📊 Full record: ${LINK}`,
    '',
    '<i>18+ · Please gamble responsibly · begambleaware.org</i>'
  );
  return send(lines.join('\n'));
}

/** Announce a settled result, with the running total. */
export function announceResult(tip, profit, running) {
  const won = tip.result === 'win';
  const head = tip.result === 'void'
    ? '➖ <b>VOID</b>'
    : won
      ? '✅ <b>WINNER</b>'
      : '❌ <b>NO LUCK</b>';

  const lines = [
    head,
    '',
    `<b>${esc(tip.dog)}</b> — Trap ${tip.trap}, ${esc(tip.track)}`,
  ];
  if (tip.result !== 'void') lines.push(`${fmtPts(profit)} pts on the day`);
  lines.push(
    '',
    `<b>Running total: ${fmtPts(running)} pts</b>`,
    '',
    won
      ? 'Next free selection coming up.'
      : 'Every result posted, win or lose.',
    '',
    `📊 ${LINK}`
  );
  return send(lines.join('\n'), true);
}

/* ------------------------------- HORSES -------------------------------- */

const dayLabel = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
};

/** Announce the day's horse card. */
export function announceHorseCard(iso, tips, opts = {}) {
  const lines = [`🏇 <b>SELECTIONS — ${dayLabel(iso).toUpperCase()}</b>`, ''];

  for (const t of tips) {
    const who = opts.showTipster && t.tipster ? `${esc(t.tipster)} · ` : '';
    lines.push(`${who}<b>${esc(t.horse)}</b>`);
    lines.push(`${esc(t.time)} ${esc(t.course)} · ${esc(t.price)} · ${t.stake}pt ${t.betType === 'ew' ? 'e/w' : 'win'}`);
    if (t.writeup) lines.push(`<i>${esc(String(t.writeup).slice(0, 400))}</i>`);
    lines.push('');
  }

  lines.push(
    `📊 Full write-ups: ${LINK.replace('#greyhounds', '')}`,
    '',
    '<i>18+ · Please gamble responsibly · begambleaware.org</i>'
  );
  return send(lines.join('\n'));
}

/** Announce a settled horse day, with the running total. */
export function announceHorseResults(iso, tips, dayPts, running) {
  const lines = [`📋 <b>RESULTS — ${dayLabel(iso).toUpperCase()}</b>`, ''];

  for (const t of tips) {
    const mark = t.result === 'won' ? '✅' : t.result === 'placed' ? '🟡' : t.result === 'void' ? '➖' : '❌';
    lines.push(`${mark} <b>${esc(t.horse)}</b> — ${esc(t.result).toUpperCase()}`);
  }

  lines.push(
    '',
    `<b>${fmtPts(dayPts)} pts on the day</b>`,
    `Running total: ${fmtPts(running)} pts`,
    '',
    dayPts >= 0 ? 'Back tomorrow.' : 'Every result posted, win or lose. Back tomorrow.',
    '',
    `📊 ${LINK.replace('#greyhounds', '')}`
  );
  return send(lines.join('\n'), true);
}

export { fmtDate };

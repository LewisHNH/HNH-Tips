// Sends the day's card to the MailerLite list as an instant campaign.
//
// Two calls: create a draft campaign, then schedule it for instant delivery.
// Entirely optional — with no API key set, nothing happens and nothing breaks.

const API = 'https://connect.mailerlite.com/api';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

function dayLabel(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Plain, dark-on-light HTML. Email clients are not browsers — keep it simple. */
function buildHtml(iso, tips, siteUrl) {
  const rows = tips.map((t) => `
    <tr><td style="padding:18px 0;border-bottom:1px solid #e5e5e5;">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#888;">
        ${esc(t.time)} &middot; ${esc(t.course)}${t.tipster ? ` &middot; ${esc(t.tipster)}` : ''}
      </div>
      <div style="font-size:20px;font-weight:700;letter-spacing:1px;margin:6px 0;color:#111;">
        ${esc(t.horse).toUpperCase()}
      </div>
      <div style="font-size:14px;color:#444;">
        ${esc(t.price)} &middot; ${esc(t.stake)}pt ${t.betType === 'ew' ? 'each-way' : 'win'}
      </div>
      ${t.writeup ? `<div style="font-size:14px;line-height:1.6;color:#555;margin-top:10px;">
        ${esc(String(t.writeup).slice(0, 800))}</div>` : ''}
    </td></tr>`).join('');

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="max-width:560px;background:#fff;padding:28px;font-family:Arial,Helvetica,sans-serif;">
  <tr><td style="text-align:center;padding-bottom:8px;">
    <div style="font-size:20px;font-weight:700;letter-spacing:4px;color:#111;">HORSES BY HNH</div>
  </td></tr>
  <tr><td style="text-align:center;padding-bottom:18px;">
    <div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#888;">
      ${esc(dayLabel(iso))}
    </div>
  </td></tr>
  ${rows}
  <tr><td style="padding-top:22px;text-align:center;">
    <a href="https://${esc(siteUrl)}"
       style="font-size:14px;color:#111;font-weight:700;">Full record and past results &rsaquo;</a>
  </td></tr>
  <tr><td style="padding-top:22px;font-size:11px;line-height:1.7;color:#999;text-align:center;">
    18+ &middot; Tips are opinion, not advice. Never stake more than you can afford to lose.<br>
    Prices were available at time of sending. Support at BeGambleAware.org.<br>
    <a href="{$unsubscribe}" style="color:#999;">Unsubscribe</a>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

async function call(path, body, key) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `MailerLite ${res.status}`);
  }
  return data;
}

/**
 * Create and immediately send the day's card.
 * Returns { skipped } when not configured, so callers can report it plainly.
 */
export async function emailHorseCard(iso, tips, siteUrl = 'tips.hoovesnhounds.com') {
  const key = process.env.MAILERLITE_API_KEY;
  if (!key) return { skipped: 'MailerLite not configured' };

  const groupId = process.env.MAILERLITE_GROUP_ID;
  const from = process.env.MAILERLITE_FROM_EMAIL;
  const fromName = process.env.MAILERLITE_FROM_NAME || 'Hooves & Hounds';
  if (!from) return { skipped: 'No MAILERLITE_FROM_EMAIL set' };

  try {
    const created = await call('/campaigns', {
      name: `Selections — ${iso}`,
      type: 'regular',
      language_id: Number(process.env.MAILERLITE_LANGUAGE_ID) || 1,
      ...(groupId ? { groups: [String(groupId)] } : {}),
      emails: [{
        subject: `${tips.length} selection${tips.length === 1 ? '' : 's'} — ${dayLabel(iso)}`,
        from,
        from_name: fromName,
        content: buildHtml(iso, tips, siteUrl),
      }],
    }, key);

    const id = created?.data?.id;
    if (!id) return { error: 'No campaign id returned' };

    await call(`/campaigns/${id}/schedule`, { delivery: 'instant' }, key);
    return { sent: true, campaignId: id };
  } catch (error) {
    return { error: error.message };
  }
}

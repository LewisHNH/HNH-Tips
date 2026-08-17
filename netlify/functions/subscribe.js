// Adds an email to the MailerLite list.
//
// Deliberately public — it's a signup form. The only things it will do are
// add an address to one list and return ok, so there's nothing to abuse
// beyond adding junk addresses, which MailerLite's own bounce handling deals
// with. It never reads or returns subscriber data.

const API = 'https://connect.mailerlite.com/api';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// Deliberately loose. Real validation is whether the address accepts mail,
// which only MailerLite can find out.
const looksLikeEmail = (s) =>
  typeof s === 'string' && s.length < 255 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());

export default async function handler(request) {
  if (request.method.toUpperCase() !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const key = process.env.MAILERLITE_API_KEY;
  if (!key) return json({ error: 'Signups are not set up yet.' }, 503);

  try {
    const { email } = await request.json();
    if (!looksLikeEmail(email)) {
      return json({ error: "That doesn't look like an email address." }, 400);
    }

    const groupId = process.env.MAILERLITE_GROUP_ID;
    const res = await fetch(`${API}/subscribers`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        email: String(email).trim().toLowerCase(),
        ...(groupId ? { groups: [String(groupId)] } : {}),
      }),
    });

    const data = await res.json().catch(() => ({}));

    // 422 usually means already subscribed — from the visitor's point of view
    // that's a success, so don't make them feel they've done something wrong.
    if (res.ok || res.status === 422) return json({ ok: true });

    return json({ error: data.message || 'Could not sign you up just now.' }, 502);
  } catch (error) {
    return json({ error: 'Could not sign you up just now.' }, 500);
  }
}

export const config = { path: '/api/subscribe' };

import { announceHorseCard, announceHorseResults } from './telegram.js';
import { emailHorseCard } from './mailerlite.js';

// Announces horse cards and results to Telegram.
// Kept separate from /api/tips so the existing save path is untouched —
// a Telegram failure can never affect whether a tip saves.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function isAdmin(request) {
  const token = process.env.HNH_ADMIN_TOKEN || process.env.ADMIN_PASSWORD;
  if (!token) return false;
  return request.headers.get('x-admin-password') === token;
}

export default async function handler(request) {
  if (request.method.toUpperCase() !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!isAdmin(request)) return json({ error: 'Not authorised' }, 401);

  try {
    const body = await request.json();
    const { type, date, tips } = body;

    if (!date || !Array.isArray(tips) || !tips.length) {
      return json({ error: 'Missing date or tips' }, 400);
    }

    if (type === 'card') {
      // Both go out together, but independently — an email failure must not
      // stop the Telegram post, and vice versa.
      const [telegram, email] = await Promise.all([
        announceHorseCard(date, tips, { showTipster: body.showTipster !== false }),
        body.email === false ? Promise.resolve({ skipped: 'opted out' }) : emailHorseCard(date, tips),
      ]);
      return json({ ok: true, telegram, email });
    }

    if (type === 'results') {
      const result = await announceHorseResults(
        date,
        tips,
        Number(body.dayPts) || 0,
        Number(body.running) || 0
      );
      return json({ ok: true, telegram: result });
    }

    return json({ error: 'type must be card or results' }, 400);
  } catch (error) {
    return json({ error: error.message || 'Something went wrong' }, 500);
  }
}

export const config = { path: '/api/horse-notify' };

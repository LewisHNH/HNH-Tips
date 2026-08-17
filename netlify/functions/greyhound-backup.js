import { getStore } from '@netlify/blobs';

// One-file backup of everything in the greyhound store.
//
// Netlify Blobs has no export, and the proofed record is the one asset here
// that can't be rebuilt. Hit this URL with the admin password and save what
// comes back. Do it monthly.

const STORE = 'hnh-greyhounds';

function isAdmin(request) {
  const token = process.env.HNH_ADMIN_TOKEN || process.env.ADMIN_PASSWORD;
  if (!token) return false;
  const url = new URL(request.url);
  // Header for scripts, query string so it can be opened in a browser.
  return request.headers.get('x-admin-password') === token
    || url.searchParams.get('key') === token;
}

export default async function handler(request) {
  if (!isAdmin(request)) {
    return new Response(JSON.stringify({ error: 'Not authorised' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    const store = getStore(STORE);
    const { blobs } = await store.list();

    const entries = await Promise.all(
      blobs.map(async (b) => [b.key, await store.get(b.key, { type: 'json' })])
    );

    const payload = {
      store: STORE,
      exportedAt: new Date().toISOString(),
      count: entries.length,
      data: Object.fromEntries(entries),
    };

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="hnh-greyhounds-${stamp}.json"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export const config = { path: '/api/greyhound-backup' };

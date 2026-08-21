// netlify/functions/hnh-inspect.js
//
// TEMPORARY. Delete this once the brain is reading your real data.
// It exists so I can see the exact shape of your existing records
// without you pasting whole files from your phone.
//
//   /.netlify/functions/hnh-inspect?pw=YOUR_ADMIN_PASSWORD
//
// Optional: inspect one specific store in more detail
//   /.netlify/functions/hnh-inspect?pw=...&store=hnh-greyhounds&full=1

import { getStore } from '@netlify/blobs';

// Candidate store names. Ones that don't exist just come back empty.
const CANDIDATES = [
  'hnh-greyhounds',
  'hnh-events',
  'hnh-tips',
  'tips',
  'hnh-horses',
  'horses',
  'hnh',
];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function inspectStore(name, full) {
  try {
    const store = getStore(name);
    const listed = await store.list();
    const keys = (listed.blobs || []).map((b) => b.key).sort();

    if (!keys.length) return { store: name, exists: false, keys: 0 };

    // Grab a couple of samples so I can see the record shape.
    const sampleKeys = full ? keys.slice(0, 6) : keys.slice(-2);
    const samples = {};
    for (const k of sampleKeys) {
      try {
        const val = await store.get(k, { type: 'json' });
        // Trim long arrays so the response stays readable on a phone.
        if (Array.isArray(val)) {
          samples[k] = {
            _arrayLength: val.length,
            _firstTwo: val.slice(0, 2),
          };
        } else if (val && typeof val === 'object') {
          const trimmed = {};
          for (const [kk, vv] of Object.entries(val)) {
            trimmed[kk] = Array.isArray(vv)
              ? { _arrayLength: vv.length, _firstTwo: vv.slice(0, 2) }
              : vv;
          }
          samples[k] = trimmed;
        } else {
          samples[k] = val;
        }
      } catch (err) {
        samples[k] = `<could not read: ${err.message}>`;
      }
    }

    return {
      store: name,
      exists: true,
      keyCount: keys.length,
      firstKey: keys[0],
      lastKey: keys[keys.length - 1],
      allKeys: full ? keys : keys.slice(0, 40),
      samples,
    };
  } catch (err) {
    return { store: name, error: err.message };
  }
}

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('pw') !== process.env.ADMIN_PASSWORD) {
    return new Response('unauthorised', { status: 401 });
  }

  const one = url.searchParams.get('store');
  const full = url.searchParams.get('full') === '1';

  try {
    if (one) return json(await inspectStore(one, full));

    const results = [];
    for (const name of CANDIDATES) {
      results.push(await inspectStore(name, false));
    }
    return json({
      found: results.filter((r) => r.exists),
      empty: results.filter((r) => !r.exists && !r.error).map((r) => r.store),
      errors: results.filter((r) => r.error),
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};

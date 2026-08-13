import { getStore } from "@netlify/blobs";

/* Tips API.
   GET  /api/tips  → public, returns every day's selections
   POST /api/tips  → requires the x-admin-password header
                     body { verify: true }  just checks the password
                     body { days: {...} }   saves the whole record

   The password lives in the ADMIN_PASSWORD environment variable, set in the
   Netlify dashboard. It is never sent to the browser — the browser sends its
   attempt here and this function decides. That's the whole point of moving it
   server-side: anything in the bundle can be read by anyone. */

const KEY = "days";

// Timing-safe-ish comparison so the response time doesn't leak the password.
function matches(a = "", b = "") {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async (request) => {
  const store = getStore("hnh-tips");
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  if (request.method === "GET") {
    try {
      const days = (await store.get(KEY, { type: "json" })) || {};
      return json({ days });
    } catch {
      return json({ days: {} });
    }
  }

  if (request.method === "POST") {
    const secret = process.env.ADMIN_PASSWORD;
    if (!secret) return json({ error: "ADMIN_PASSWORD not configured" }, 500);

    const supplied = request.headers.get("x-admin-password") || "";
    if (!matches(supplied, secret)) return json({ error: "unauthorised" }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "bad request" }, 400); }

    if (body.verify) return json({ ok: true });

    if (!body.days || typeof body.days !== "object") {
      return json({ error: "days missing" }, 400);
    }

    await store.setJSON(KEY, body.days);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/tips" };

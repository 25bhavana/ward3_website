/**
 * Ward 3 — Citizen Complaint Relay (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * Purpose: receive complaint JSON from the website, validate it server-side,
 *          then forward a clean payload to your PRIVATE Make.com webhook.
 *
 * Why a Worker instead of posting straight to Make from the browser?
 *   - Your Make webhook URL stays SECRET (stored as a Worker secret, never in
 *     the public site), so it can't be scraped and spammed.
 *   - Real server-side validation, honeypot and rate limiting (a browser can't
 *     be trusted to enforce these).
 *   - Proper CORS, so only your site can call it.
 *
 * SETUP (dashboard, no CLI needed):
 *   1. Cloudflare dashboard -> Workers & Pages -> Create -> Worker. Paste this.
 *   2. Settings -> Variables and Secrets:
 *        MAKE_WEBHOOK_URL  (Secret)  = your NEW Make webhook URL
 *        ALLOWED_ORIGIN    (Text)    = https://25bhavana.github.io
 *   3. (Optional, for rate limiting) Storage -> KV -> create a namespace,
 *        then bind it to this Worker as   RL   (Variable name: RL).
 *   4. Deploy. Copy the Worker URL (e.g. https://ward3-relay.<sub>.workers.dev)
 *      and set it as RELAY_URL in index.html.
 * ---------------------------------------------------------------------------
 */

const ALLOWED_CATEGORIES = ['Water', 'Roads', 'Drainage', 'Women and Child Welfare', 'Other'];
const MAX_PER_WINDOW = 5;        // max submissions per IP ...
const WINDOW_SECONDS = 600;      // ... per 10 minutes (needs the KV binding "RL")

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405, cors);

    if (!env.MAKE_WEBHOOK_URL) return json({ ok: false, error: 'Relay not configured' }, 500, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, error: 'Invalid JSON' }, 400, cors); }

    // Honeypot (if the site ever forwards the hidden field): a filled value = bot.
    if (body._honey && String(body._honey).trim() !== '') return json({ ok: true }, 200, cors);

    // ---- Server-side validation ----
    const fullName = clean(body.fullName, 100);
    const mobile = String(body.mobile || '').replace(/\D/g, '');
    const ward = clean(body.ward, 20) || 'N/A';
    const category = clean(body.category, 40);
    const message = clean(body.message, 3000);

    const errors = [];
    if (!fullName) errors.push('name');
    if (!/^[0-9]{10}$/.test(mobile)) errors.push('mobile');
    if (!ALLOWED_CATEGORIES.includes(category)) errors.push('category');
    if (!message) errors.push('message');
    if (errors.length) return json({ ok: false, error: 'Validation failed', fields: errors }, 422, cors);

    // ---- Rate limiting (only if a KV namespace is bound as RL) ----
    if (env.RL) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const key = 'rl:' + ip;
      const count = parseInt((await env.RL.get(key)) || '0', 10);
      if (count >= MAX_PER_WINDOW) return json({ ok: false, error: 'Too many requests' }, 429, cors);
      await env.RL.put(key, String(count + 1), { expirationTtl: WINDOW_SECONDS });
    }

    // ---- Forward a clean payload to Make ----
    const payload = {
      reference: clean(body.reference, 40) || 'WD3-' + Date.now().toString(36).toUpperCase(),
      fullName, mobile, ward, category, message,
      submittedAt: new Date().toISOString(),
      source: 'ward3_website',
    };

    try {
      const r = await fetch(env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) return json({ ok: false, error: 'Upstream error' }, 502, cors);
    } catch {
      return json({ ok: false, error: 'Upstream unreachable' }, 502, cors);
    }

    return json({ ok: true, reference: payload.reference }, 200, cors);
  },
};

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

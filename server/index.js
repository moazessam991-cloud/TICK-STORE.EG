'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const dbApi = require('./database');
const { seedIfEmpty } = require('./defaults');
const twilioWa = require('./twilioWhatsApp');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

global.WebSocket = WebSocket;

function sanitizeString(str, maxLen = 1000) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen).replace(/<[^>]*>?/gm, ''); // Basic tag removal
}

function escapeHtml(value) {
  const entities = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => entities[character]);
}

const SALT = process.env.TICK_PW_SALT || 'TICK_CAIRO_2026_SALT_MZ';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const configuredAdminHash = process.env.TICK_ADMIN_HASH;
const configuredAdminPassword = process.env.TICK_ADMIN_PASSWORD;

if (!configuredAdminHash && !configuredAdminPassword && IS_PRODUCTION) {
  throw new Error('Missing required environment variable: TICK_ADMIN_HASH or TICK_ADMIN_PASSWORD');
}

const ADMIN_PASS_HASH =
  configuredAdminHash ||
  (configuredAdminPassword
    ? crypto.createHash('sha256').update(SALT + configuredAdminPassword).digest('hex')
    : crypto.randomBytes(32).toString('hex'));

if (!configuredAdminHash && !configuredAdminPassword) {
  console.warn('TICK_ADMIN_HASH or TICK_ADMIN_PASSWORD is not configured; admin login is disabled.');
}

const configuredJwtSecret = process.env.TICK_JWT_SECRET;

if (!configuredJwtSecret && IS_PRODUCTION) {
  throw new Error('Missing required environment variable: TICK_JWT_SECRET');
}

const JWT_SECRET = configuredJwtSecret || crypto.randomBytes(32).toString('hex');

if (!configuredJwtSecret) {
  console.warn('TICK_JWT_SECRET is not configured; using an ephemeral development secret.');
}
const PORT = Number(process.env.PORT || 38471);
const HTML_CANDIDATES = [
  process.env.TICK_HTML,
  path.join(__dirname, '..', 'public', 'index.html'),
  path.join(__dirname, '..', 'tick-website-v26-final.html'),
].filter(Boolean);
const HTML_PATH = HTML_CANDIDATES.find((p) => fs.existsSync(p)) || HTML_CANDIDATES[0];

const db = dbApi.openDb();
seedIfEmpty(db, dbApi);

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  'https://baojwaqmriuxcnztixmr.supabase.co';

const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'sb_publishable_mNK6WYCml8BeBiO5GcKtmw_jNgklhdi';

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const sbAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

const SUPABASE_PAGE_SIZE = 1000;

async function fetchAllSupabaseRows(queryFactory) {
  const rows = [];

  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    const { data, error } = await queryFactory().range(
      from,
      from + SUPABASE_PAGE_SIZE - 1
    );

    if (error) throw error;

    const page = Array.isArray(data) ? data : [];
    rows.push(...page);

    if (page.length < SUPABASE_PAGE_SIZE) break;
  }

  return rows;
}

function orderCountsAsRevenue(order) {
  return !['cancelled', 'refunded'].includes(
    String(order && order.status || '').toLowerCase()
  );
}

async function sendOrderEmail(order) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;

  const items = (order.items || [])
    .map(i => `• ${escapeHtml(i.name)} × ${escapeHtml(i.qty)} = ${escapeHtml(i.price * i.qty)} EGP`)
    .join("<br>");

  const html = `
    <h2>🛒 New TICK Order</h2>

    <p><strong>Customer:</strong> ${escapeHtml(order.customer.fn)} ${escapeHtml(order.customer.ln)}</p>
    <p><strong>Phone:</strong> ${escapeHtml(order.customer.ph)}</p>
    <p><strong>Email:</strong> ${escapeHtml(order.customer.email || "-")}</p>
    <p><strong>Payment:</strong> ${escapeHtml(order.payment)}</p>
    <p><strong>Total:</strong> ${escapeHtml(order.total)} EGP</p>

    <hr>

    <h3>Items</h3>

    ${items}

    <hr>

    <p><strong>Address:</strong></p>

    <p>
      ${escapeHtml(order.customer.area)}<br>
      ${escapeHtml(order.customer.addr)}
    </p>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "TICK <onboarding@resend.dev>",
      to: process.env.ADMIN_EMAIL,
      subject: `🛒 New Order - ${order.customer.fn}`,
      html,
    }),
  });
  await res.text();

  console.log("RESEND STATUS:", res.status);
  if (!res.ok) {
    console.error(`Resend failed (${res.status})`);
  }
}
const app = express();
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}
app.use(helmet({
  contentSecurityPolicy: false, // Site is a large SPGA with many inline scripts/styles for now
}));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'too_many_login_attempts' },
  standardHeaders: true,
  legacyHeaders: false,
});

const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'too_many_requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

/* ─── Stage 1: health ─── */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'tick-store',
    time: new Date().toISOString(),
    twilio_whatsapp: twilioWa.isConfigured(),
  });
});

/* Single-page HTML (do not expose whole Downloads as static files) */
const htmlExists = fs.existsSync(HTML_PATH);
if (htmlExists) {
  // Support SPA routing: serve index.html for all non-API routes
  app.get(/^(?!\/api\/)/, (req, res) => {
    res.sendFile(HTML_PATH);
  });
} else {
  app.get('/', (req, res) => {
    res
      .status(503)
      .type('html')
      .send(
        `<!DOCTYPE html><html><body><p>Set <code>TICK_HTML</code> to your tick-website HTML path.</p><p><a href="/api/health">/api/health</a></p></body></html>`
      );
  });
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' });
  }
  try {
    req.admin = jwt.verify(h.slice(7), JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}
app.post('/api/admin/push-token', requireAuth, async (req, res) => {
  try {
    if (!sbAdmin) {
      console.error('SUPABASE_SERVICE_ROLE_KEY is not configured');

      return res.status(503).json({
        error: 'push_notifications_not_configured',
      });
    }

    const token =
      typeof req.body?.token === 'string'
        ? req.body.token.trim()
        : '';

    const deviceName = sanitizeString(
      req.body?.deviceName || req.body?.device_name || 'Admin device',
      120
    );

    const platform = sanitizeString(
      req.body?.platform || 'web',
      40
    );

    if (token.length < 50 || token.length > 4096) {
      return res.status(400).json({
        error: 'invalid_push_token',
      });
    }

    const { error } = await sbAdmin
      .from('push_tokens')
      .upsert(
        {
          token,
          device_name: deviceName || 'Admin device',
          platform: platform || 'web',
          last_seen: new Date().toISOString(),
        },
        {
          onConflict: 'token',
        }
      );

    if (error) {
      console.error('Failed to save admin push token:', error.message);

      return res.status(500).json({
        error: 'push_token_save_failed',
      });
    }

    return res.json({
      ok: true,
    });
  } catch (error) {
    console.error('Admin push token endpoint failed:', error);

    return res.status(500).json({
      error: 'internal_error',
    });
  }
});
const loginFails = new Map();
function loginThrottle(ip) {
  const now = Date.now();
  const row = loginFails.get(ip) || { n: 0, until: 0 };
  if (row.until > now) return false;
  if (row.until && row.until <= now) {
    row.n = 0;
    row.until = 0;
  }
  return true;
}
function loginRecordFail(ip) {
  const row = loginFails.get(ip) || { n: 0, until: 0 };
  row.n += 1;
  if (row.n >= 8) {
    row.until = Date.now() + 15 * 60 * 1000;
    row.n = 0;
  }
  loginFails.set(ip, row);
}
function loginClear(ip) {
  loginFails.delete(ip);
}

/* ─── Stage 2: auth (same hash scheme as browser admin) ─── */
app.post('/api/auth/login', authLimiter, (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'local';
  if (!loginThrottle(ip)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  const hash = crypto.createHash('sha256').update(SALT + password).digest('hex');
  if (hash !== ADMIN_PASS_HASH) {
    loginRecordFail(ip);
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  loginClear(ip);
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  return res.json({ ok: true, token, expiresIn: 12 * 3600 });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, role: req.admin.role });
});

/* ─── Stage 3: admin dashboard + local-only KV ───
   /api/public/bootstrap used to serve products/archive/straps/episodes/
   settings/reviews from this same local dbApi store, but index.html has no
   remaining caller for it — the storefront hydrates all of those straight
   from Supabase now (__tickBootstrapFromApi() / sbGetProducts() etc in
   supabase-client.js), so this route was removed as dead code rather than
   left to silently drift out of sync with the real data. ─── */

// Only drops/audit remain here: everything else this set used to gate
// (products, archive, straps, episodes, settings, orders, customers,
// subscribers, reviews, notify_me) is Supabase's responsibility now — see
// /api/admin/bootstrap below, which reads those straight from Supabase, and
// supabase-client.js on the frontend, which writes them there directly.
// drops/announces have no Supabase table by design and stay local-only.
const ADMIN_KEYS = new Set(['drops', 'audit']);

app.get('/api/admin/kv/:key', requireAuth, (req, res) => {
  const key = req.params.key;
  if (!ADMIN_KEYS.has(key)) return res.status(400).json({ error: 'unknown_key' });
  res.json({ key, value: dbApi.getJson(db, key) });
});

app.put('/api/admin/kv/:key', requireAuth, (req, res) => {
  const key = req.params.key;
  if (!ADMIN_KEYS.has(key)) return res.status(400).json({ error: 'unknown_key' });
  if (!('value' in req.body)) return res.status(400).json({ error: 'missing_value' });
  dbApi.setJson(db, key, req.body.value);
  res.json({ ok: true, key });
});

app.post('/api/admin/sync', requireAuth, (req, res) => {
  const body = req.body || {};
  let n = 0;
  for (const key of ADMIN_KEYS) {
    if (key in body) {
      dbApi.setJson(db, key, body[key]);
      n += 1;
    }
  }
  res.json({ ok: true, updated: n });
});

app.get('/api/admin/bootstrap', requireAuth, async (req, res) => {
  // Orders/customers/subscribers/notify_me/reviews/settings all now live in
  // Supabase — the frontend writes them there directly (sbCreateOrder,
  // sbSubscribeEmail, the raw sbClient inserts for reviews/notify_me,
  // sbSaveProduct/sbSaveSetting/etc). Reading them back from this local
  // dbApi store, as this endpoint used to, meant admin almost never saw real
  // customer activity: a customer's own browser has no tick_api_token, so
  // none of a real customer's checkout/review/notify-me/newsletter writes
  // ever reached the Express-side store to begin with — only drops/audit
  // (no Supabase table by design) still come from dbApi below.
  if (!sbAdmin) {
    return res.status(503).json({ error: 'supabase_admin_not_configured' });
  }

  try {
    const [orderRows, subscriberRows, notifyRows, reviewRows, settingRows] = await Promise.all([
      fetchAllSupabaseRows(() => sbAdmin
        .from('orders')
        .select('*, order_items(*, products(name, emoji, brand, categories(slug)))')
        .order('created_at', { ascending: false })),
      fetchAllSupabaseRows(() => sbAdmin
        .from('subscribers')
        .select('*')
        .order('subscribed_at', { ascending: false })),
      fetchAllSupabaseRows(() => sbAdmin
        .from('notify_me')
        .select('*')
        .order('created_at', { ascending: false })),
      fetchAllSupabaseRows(() => sbAdmin
        .from('reviews')
        .select('*')
        .order('created_at', { ascending: false })),
      fetchAllSupabaseRows(() => sbAdmin
        .from('settings')
        .select('*')
        .order('key', { ascending: true })),
    ]);

    // Reshape each Supabase row into the {id, items, total, customer,
    // payment, status, notes, date} object placeOrder() already builds
    // locally at checkout, so the admin dashboard needs no rendering changes.
    const orders = orderRows.map((row) => ({
      id: row.id,
      items: (row.order_items || []).map((it) => ({
        pid: it.product_id,
        name: (it.metadata && it.metadata.product_name) || (it.products && it.products.name) || 'Product',
        emoji: (it.metadata && it.metadata.emoji) || (it.products && it.products.emoji) || (it.metadata && it.metadata.type === 'strap' ? '🪢' : '⌚'),
        brand: (it.metadata && it.metadata.brand) || (it.products && it.products.brand) || '',
        price: Number(it.price_at_purchase) || 0,
        qty: it.quantity || 1,
        isSt: !!(it.metadata && it.metadata.type === 'strap'),
        strapConfig: (it.metadata && it.metadata.config) || null,
        category_slug:
          (it.metadata && it.metadata.category_slug) ||
          (it.products && it.products.categories && it.products.categories.slug) ||
          '',
      })),
      total: Number(row.total_amount) || 0,
      // shipping_address is the full checkout object (fn/ln/ph/email/area/
      // city/addr/notes) sbCreateOrder stores verbatim — it's already in the
      // exact shape the admin UI's o.customer.* reads expect, unlike the
      // flattened customer_name/_phone/_email columns, so it's preferred
      // here and those columns are only a fallback for very old rows.
      customer: row.shipping_address || {
        fn: row.customer_name || '',
        ln: '',
        ph: row.customer_phone || '',
        email: row.customer_email || '',
        area: '',
      },
      payment: row.payment_method || '',
      paymentStatus: row.payment_status || 'unpaid',
      status: row.status || 'pending',
      notes: row.notes || (row.shipping_address && row.shipping_address.notes) || '',
      date: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    }));

    // No dedicated Supabase table for customers — derive the same
    // {id,name,phone,email,area,orders,spent,joined,lastOrder} shape the old
    // dbApi-backed list used, by aggregating the real orders above (grouped
    // by phone), so this is a read-time view over Supabase's orders rather
    // than a second, independently-written store.
    const customersByPhone = new Map();
    for (const o of orders) {
      const phone = o.customer && o.customer.ph;
      if (!phone) continue;
      const countsAsRevenue = orderCountsAsRevenue(o);
      const existing = customersByPhone.get(phone);
      if (existing) {
        existing.orders += countsAsRevenue ? 1 : 0;
        existing.spent += countsAsRevenue ? o.total : 0;
        if (o.date > existing.lastOrder) existing.lastOrder = o.date;
        if (o.date < existing.joined) existing.joined = o.date;
        if (o.customer.email) existing.email = o.customer.email;
        if (o.customer.area) existing.area = o.customer.area;
      } else {
        customersByPhone.set(phone, {
          id: `c_${phone}`,
          name: `${o.customer.fn || ''} ${o.customer.ln || ''}`.trim(),
          phone,
          email: o.customer.email || '',
          area: o.customer.area || '',
          orders: countsAsRevenue ? 1 : 0,
          spent: countsAsRevenue ? o.total : 0,
          joined: o.date,
          lastOrder: o.date,
        });
      }
    }

    const subscribers = subscriberRows.map((row) => ({
      email: row.email,
      date: row.subscribed_at ? new Date(row.subscribed_at).getTime() : Date.now(),
      source: row.source || 'newsletter',
    }));

    const notify_me = notifyRows.map((row) => ({
      pid: row.product_id || row.pid,
      contact: row.contact_raw || row.email || row.phone || '',
      date: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    }));

    // Grouped by product id, each entry normalized the same way
    // normalizeReview() does on the frontend (rating->stars, customer_name->
    // name, comment->text, created_at->epoch ms).
    const reviews = {};
    for (const row of reviewRows) {
      const key = String(row.product_id);
      if (!reviews[key]) reviews[key] = [];
      reviews[key].push({
        id: row.id,
        stars: row.rating != null ? row.rating : 0,
        name: row.customer_name || 'Anonymous',
        text: row.comment || '',
        date: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
      });
    }

    const settings = {};
    for (const row of settingRows) settings[row.key] = row.value;

    res.json({
      orders,
      customers: Array.from(customersByPhone.values()),
      subscribers,
      notify_me,
      reviews,
      settings,
      // drops/audit: no Supabase table by design (see ADMIN_KEYS) — still
      // Express/local dbApi, the only persistence they have.
      drops: dbApi.getJson(db, 'drops') || [],
      audit: dbApi.getJson(db, 'audit') || [],
    });
  } catch (e) {
    console.error('admin bootstrap error', e);
    res.status(500).json({ error: 'server' });
  }
});

app.patch('/api/admin/orders/:id/status', requireAuth, async (req, res) => {
  if (!sbAdmin) {
    return res.status(503).json({ error: 'supabase_admin_not_configured' });
  }

  const status = sanitizeString(req.body && req.body.status, 20).toLowerCase();
  const allowed = new Set(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded']);

  if (!allowed.has(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }

  const { data, error } = await sbAdmin
    .from('orders')
    .update({ status })
    .eq('id', req.params.id)
    .select('id, status')
    .maybeSingle();

  if (error) {
    console.error('order status update error', error);
    return res.status(500).json({ error: 'order_status_update_failed' });
  }

  if (!data) return res.status(404).json({ error: 'order_not_found' });
  return res.json({ ok: true, order: data });
});

app.post('/api/admin/products/:id/restock', requireAuth, async (req, res) => {
  if (!sbAdmin) {
    return res.status(503).json({ error: 'supabase_admin_not_configured' });
  }

  const quantity = Number(req.body && req.body.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100000) {
    return res.status(400).json({ error: 'invalid_restock_quantity' });
  }

  const { data, error } = await sbAdmin.rpc('adjust_product_stock', {
    p_product_id: req.params.id,
    p_delta: quantity,
  });

  if (error) {
    console.error('product restock error', error);
    return res.status(500).json({ error: 'product_restock_failed' });
  }

  if (!data) return res.status(404).json({ error: 'product_not_found' });
  return res.json({ ok: true, product: data });
});

app.delete('/api/admin/notify-me', requireAuth, async (req, res) => {
  if (!sbAdmin) {
    return res.status(503).json({ error: 'supabase_admin_not_configured' });
  }

  const { error } = await sbAdmin
    .from('notify_me')
    .delete()
    .not('id', 'is', null);

  if (error) {
    console.error('notify-me clear error', error);
    return res.status(500).json({ error: 'notify_me_clear_failed' });
  }

  return res.json({ ok: true });
});

function twilioWebhookFullUrl(req) {
  const base = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (base) return `${String(base).replace(/\/$/, '')}/api/webhooks/twilio/whatsapp`;
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}/api/webhooks/twilio/whatsapp`;
}

/* Twilio inbound WhatsApp (status + user messages) */
app.post(
  '/api/webhooks/twilio/whatsapp',
  express.urlencoded({ extended: false }),
  (req, res) => {
    if (process.env.TWILIO_SKIP_WEBHOOK_VERIFY === '1') {
      /* local tunnel / tests only */
    } else if (!twilioWa.validateWebhook(twilioWebhookFullUrl(req), req.body, req.get('X-Twilio-Signature'))) {
      return res.status(403).type('text/plain').send('Forbidden');
    }
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
);

app.post('/api/admin/whatsapp/send', requireAuth, async (req, res) => {
  if (!twilioWa.isConfigured()) {
    return res.status(503).json({ error: 'twilio_not_configured' });
  }
  try {
    const out = await twilioWa.sendWhatsApp({ to: req.body.to, body: req.body.body });
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.code === 'INVALID_TO') return res.status(400).json({ error: 'invalid_to' });
    if (e.code === 'EMPTY_BODY') return res.status(400).json({ error: 'empty_body' });
    if (e.code === 'BODY_TOO_LONG') return res.status(400).json({ error: 'body_too_long' });
    if (e.code === 'TWILIO_NOT_CONFIGURED') return res.status(503).json({ error: 'twilio_not_configured' });
    console.error('twilio send', e);
    return res.status(502).json({ error: 'twilio_send_failed', message: e.message });
  }
});

/* ─── Stage 4: checkout compatibility route ───
   The storefront uses the create-order Edge Function. Keep this legacy
   endpoint on the exact same database transaction so reconnecting an older
   client cannot reintroduce a partial/untrusted second order path. ─── */
app.post('/api/public/order', publicApiLimiter, async (req, res) => {
  const order = req.body && req.body.order;
  if (!order || typeof order.id !== 'string' || !Array.isArray(order.items) || order.items.length === 0) {
    return res.status(400).json({ error: 'invalid_order' });
  }

  // Basic validation of order fields
  if (isNaN(Number(order.total)) || Number(order.total) < 0) {
    return res.status(400).json({ error: 'invalid_total' });
  }

  // Sanitize customer data
  if (order.customer) {
    order.customer.fn = sanitizeString(order.customer.fn, 50);
    order.customer.ln = sanitizeString(order.customer.ln, 50);
    order.customer.ph = sanitizeString(order.customer.ph, 20);
    order.customer.email = sanitizeString(order.customer.email, 100);
    order.customer.area = sanitizeString(order.customer.area, 50);
    order.customer.addr = sanitizeString(order.customer.addr, 200);
  }
  order.notes = sanitizeString(order.notes, 500);

  if (!sbAdmin) {
    return res.status(503).json({ error: 'supabase_admin_not_configured' });
  }

  try {
    const orderData = {
      total: Number(order.total),
      customer: order.customer || {},
      payment: order.payment,
      notes: order.notes,
      checkoutToken: order.checkoutToken || crypto.randomUUID(),
    };
    const items = order.items.map((it) => ({
      pid: String(it.pid || ''),
      qty: Number(it.qty),
      price: Number(it.price),
      isSt: !!it.isSt,
      strapConfig: it.strapConfig || null,
      metadata: it.metadata || null,
    }));
    const { data: savedOrder, error: orderErr } = await sbAdmin.rpc(
      'create_order_with_stock',
      { p_order: orderData, p_items: items }
    );
    if (orderErr) throw orderErr;
    if (!savedOrder || !savedOrder.id) throw new Error('order_creation_failed');

    const notifyTo = process.env.TWILIO_ORDER_NOTIFY_TO;
    if (notifyTo && twilioWa.isConfigured()) {
      const total = Number(savedOrder.total_amount) || 0;
      const cph = (order.customer && order.customer.ph) || '—';
      const pay = order.payment || '—';
      const msg = `New TICK order #${savedOrder.id}\nTotal: ${total} EGP\nPhone: ${cph}\nPayment: ${pay}`;
      twilioWa.sendWhatsApp({ to: notifyTo, body: msg }).catch((err) => console.error('Twilio order notify', err.message));
    }
    await sendOrderEmail({ ...order, total: Number(savedOrder.total_amount) || 0 });
    return res.json({ ok: true, id: savedOrder.id });
  } catch (e) {
    console.error('order error', e);
    return res.status(500).json({ error: 'server' });
  }
});

/* REMOVED as dead code (migration cleanup): /api/public/review,
   /api/public/newsletter, /api/public/notify. index.html has zero
   fetch('/api/public/...') call sites for any of these — reviews and
   notify-me insert straight into Supabase via raw window.sbClient.from(...)
   calls, and newsletter signup goes through sbSubscribeEmail() — so these
   routes had no caller, and the local dbApi shape they wrote (e.g. reviews
   keyed by {stars,name,text,date}; notify_me keyed by "productId") had
   already drifted from the real Supabase columns (rating/customer_name/
   comment; product_id) that the live code paths actually use. */

app.listen(PORT, () => {
  console.log(`TICK API listening on http://127.0.0.1:${PORT}/api/health`);
  if (!htmlExists) console.warn('HTML not found at', HTML_PATH, '(set TICK_HTML)');
});

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

function sanitizeString(str, maxLen = 1000) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen).replace(/<[^>]*>?/gm, ''); // Basic tag removal
}

const SALT = process.env.TICK_PW_SALT || 'TICK_CAIRO_2026_SALT_MZ';
const ADMIN_PASS_HASH =
  process.env.TICK_ADMIN_HASH ||
  crypto.createHash('sha256').update(SALT + (process.env.TICK_ADMIN_PASSWORD || 'ozaa7221274$')).digest('hex');
const JWT_SECRET = process.env.TICK_JWT_SECRET || 'tick-dev-secret-change-me';
if (JWT_SECRET === 'tick-dev-secret-change-me') {
  console.warn('WARNING: TICK_JWT_SECRET is using the default development secret. Please set a strong random string in production.');
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

/* ─── Stage 3: public catalog ─── */
app.get('/api/public/bootstrap', (req, res) => {
  res.json({
    products: dbApi.getJson(db, 'products') || [],
    archive: dbApi.getJson(db, 'archive') || [],
    straps: dbApi.getJson(db, 'straps') || [],
    episodes: dbApi.getJson(db, 'episodes') || [],
    settings: dbApi.getJson(db, 'settings') || {},
    reviews: dbApi.getJson(db, 'reviews') || {},
  });
});

const ADMIN_KEYS = new Set([
  'products',
  'archive',
  'straps',
  'episodes',
  'settings',
  'orders',
  'customers',
  'subscribers',
  'drops',
  'audit',
  'reviews',
  'notify_me',
]);

app.get('/api/admin/kv/:key', requireAuth, (req, res) => {
  const key = req.params.key;
  if (!ADMIN_KEYS.has(key)) return res.status(400).json({ error: 'unknown_key' });
  if (key === 'orders') {
    return res.json({ key, value: dbApi.listOrders(db, 2000) });
  }
  res.json({ key, value: dbApi.getJson(db, key) });
});

app.put('/api/admin/kv/:key', requireAuth, (req, res) => {
  const key = req.params.key;
  if (!ADMIN_KEYS.has(key)) return res.status(400).json({ error: 'unknown_key' });
  if (!('value' in req.body)) return res.status(400).json({ error: 'missing_value' });
  if (key === 'orders' && Array.isArray(req.body.value)) {
    for (const o of req.body.value) dbApi.appendOrder(db, o);
  } else {
    dbApi.setJson(db, key, req.body.value);
  }
  res.json({ ok: true, key });
});

app.post('/api/admin/sync', requireAuth, (req, res) => {
  const body = req.body || {};
  let n = 0;
  for (const key of ADMIN_KEYS) {
    if (key in body) {
      if (key === 'orders' && Array.isArray(body[key])) {
        for (const o of body[key]) dbApi.appendOrder(db, o);
      } else {
        dbApi.setJson(db, key, body[key]);
      }
      n += 1;
    }
  }
  res.json({ ok: true, updated: n });
});

app.get('/api/admin/bootstrap', requireAuth, (req, res) => {
  // Returns the current server state for the admin dashboard.
  const out = {};
  for (const key of ADMIN_KEYS) {
    if (key === 'orders') {
      out[key] = dbApi.listOrders(db, 1000);
    } else {
      out[key] = dbApi.getJson(db, key);
    }
  }
  res.json(out);
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

/* ─── Stage 4: checkout + subscribers ─── */
app.post('/api/public/order', publicApiLimiter, (req, res) => {
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

  try {
    dbApi.appendOrder(db, order);
    const phone = order.customer && order.customer.ph;
    if (phone) {
      const custs = dbApi.getJson(db, 'customers') || [];
      const total = Number(order.total) || 0;
      const ex = custs.find((c) => c.phone === phone);
      if (ex) {
        ex.orders = (ex.orders || 0) + 1;
        ex.spent = (ex.spent || 0) + total;
        ex.lastOrder = Date.now();
        if (order.customer.fn) ex.name = `${order.customer.fn} ${order.customer.ln || ''}`.trim();
        if (order.customer.email) ex.email = order.customer.email;
      } else {
        custs.push({
          id: `c_${Date.now()}`,
          name: `${(order.customer.fn || '').trim()} ${(order.customer.ln || '').trim()}`.trim(),
          phone,
          email: order.customer.email || '',
          area: order.customer.area || '',
          orders: 1,
          spent: total,
          joined: Date.now(),
          lastOrder: Date.now(),
        });
      }
      dbApi.setJson(db, 'customers', custs);
    }
    const notifyTo = process.env.TWILIO_ORDER_NOTIFY_TO;
    if (notifyTo && twilioWa.isConfigured()) {
      const total = Number(order.total) || 0;
      const cph = (order.customer && order.customer.ph) || '—';
      const pay = order.payment || '—';
      const msg = `New TICK order #${order.id}\nTotal: ${total} EGP\nPhone: ${cph}\nPayment: ${pay}`;
      twilioWa.sendWhatsApp({ to: notifyTo, body: msg }).catch((err) => console.error('Twilio order notify', err.message));
    }
    return res.json({ ok: true, id: order.id });
  } catch (e) {
    console.error('order error', e);
    return res.status(500).json({ error: 'server' });
  }
});

app.post('/api/public/review', publicApiLimiter, (req, res) => {
  const payload = req.body && req.body.review;
  const productId = payload && (payload.productId ?? payload.pid);
  const stars = payload && payload.stars;
  const name = payload && payload.name;
  const text = payload && payload.text;

  const pidKey = productId == null ? null : String(productId);
  const s = Number(stars);
  const nm = sanitizeString(name, 60);
  const tx = sanitizeString(text, 1000);

  if (!pidKey) return res.status(400).json({ error: 'missing_product' });
  if (!s || s < 1 || s > 5) return res.status(400).json({ error: 'invalid_stars' });
  if (!tx || tx.length < 10) return res.status(400).json({ error: 'invalid_text' });

  try {
    const reviews = dbApi.getJson(db, 'reviews') || {};
    if (!Array.isArray(reviews[pidKey])) reviews[pidKey] = [];
    reviews[pidKey].push({ stars: Math.round(s), name: nm || 'Anonymous', text: tx, date: Date.now() });
    // Prevent unbounded growth
    if (reviews[pidKey].length > 300) reviews[pidKey] = reviews[pidKey].slice(-300);
    dbApi.setJson(db, 'reviews', reviews);
    return res.json({ ok: true });
  } catch (e) {
    console.error('review error', e);
    return res.status(500).json({ error: 'server' });
  }
});

app.post('/api/public/newsletter', publicApiLimiter, (req, res) => {
  const email = (req.body && req.body.email && String(req.body.email).trim().toLowerCase()) || '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  const subs = dbApi.getJson(db, 'subscribers') || [];
  if (!subs.some((s) => (s.email || s) === email)) {
    subs.push({ email, ts: Date.now() });
    dbApi.setJson(db, 'subscribers', subs);
  }
  return res.json({ ok: true });
});

app.post('/api/public/notify', publicApiLimiter, (req, res) => {
  const productId = req.body && req.body.productId;
  if (productId == null) return res.status(400).json({ error: 'missing_product' });
  const row = {
    productId,
    phone: (req.body.phone && String(req.body.phone).trim()) || '',
    email: (req.body.email && String(req.body.email).trim().toLowerCase()) || '',
    ts: Date.now(),
  };
  const list = dbApi.getJson(db, 'notify_me') || [];
  list.push(row);
  dbApi.setJson(db, 'notify_me', list.slice(-2000));
  return res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`TICK API listening on http://127.0.0.1:${PORT}/api/health`);
  if (!htmlExists) console.warn('HTML not found at', HTML_PATH, '(set TICK_HTML)');
});

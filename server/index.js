'use strict';

const backendSentry = require('./sentry');

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

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const JWT_ISSUER = 'tick-store';
const JWT_AUDIENCE = 'tick-admin';
const ADMIN_PASSWORD_HASH = String(process.env.TICK_ADMIN_PASSWORD_HASH || '').trim();
const LEGACY_ADMIN_HASH = String(process.env.TICK_ADMIN_HASH || '').trim();
const DEVELOPMENT_ADMIN_PASSWORD = String(process.env.TICK_ADMIN_PASSWORD || '');
const LEGACY_PASSWORD_SALT = process.env.TICK_PW_SALT || 'TICK_CAIRO_2026_SALT_MZ';
const configuredJwtSecret = String(process.env.TICK_JWT_SECRET || '');
const PORT = Number(process.env.PORT || 38471);
const TRUST_PROXY_HOPS = process.env.TRUST_PROXY === '1' ? 1 : 0;
const PUBLIC_ORIGIN_VALUES = String(process.env.TICK_STOREFRONT_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (!['development', 'test', 'production'].includes(NODE_ENV)) {
  throw new Error('NODE_ENV must be development, test, or production');
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

function parseScryptPasswordHash(encoded) {
  const match = /^scrypt\$([A-Za-z0-9_-]{16,256})\$([A-Za-z0-9_-]{43,256})$/.exec(encoded);
  if (!match) return null;
  try {
    const salt = Buffer.from(match[1], 'base64url');
    const digest = Buffer.from(match[2], 'base64url');
    if (salt.length < 16 || digest.length !== 64) return null;
    return { salt, digest };
  } catch {
    return null;
  }
}

const parsedAdminPasswordHash = parseScryptPasswordHash(ADMIN_PASSWORD_HASH);

if (ADMIN_PASSWORD_HASH && !parsedAdminPasswordHash) {
  throw new Error('TICK_ADMIN_PASSWORD_HASH must use the documented scrypt format');
}
if (IS_PRODUCTION && !parsedAdminPasswordHash) {
  throw new Error('Missing required production variable: TICK_ADMIN_PASSWORD_HASH');
}
if (IS_PRODUCTION && (LEGACY_ADMIN_HASH || DEVELOPMENT_ADMIN_PASSWORD)) {
  throw new Error('Plaintext or legacy admin credentials are not allowed in production');
}
if (!parsedAdminPasswordHash && !LEGACY_ADMIN_HASH && !DEVELOPMENT_ADMIN_PASSWORD) {
  console.warn('Admin credentials are not configured; admin login is disabled.');
}
if (IS_PRODUCTION && configuredJwtSecret.length < 32) {
  throw new Error('TICK_JWT_SECRET must be at least 32 characters in production');
}

const JWT_SECRET = configuredJwtSecret || crypto.randomBytes(32).toString('hex');

if (!configuredJwtSecret) {
  console.warn('TICK_JWT_SECRET is not configured; using an ephemeral development secret.');
}

function normalizeConfiguredOrigin(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('TICK_STOREFRONT_ORIGINS entries must be bare HTTP(S) origins');
  }
  if (IS_PRODUCTION && parsed.protocol !== 'https:') {
    throw new Error('Production storefront origins must use HTTPS');
  }
  return parsed.origin;
}

const PUBLIC_ORIGINS = new Set(PUBLIC_ORIGIN_VALUES.map(normalizeConfiguredOrigin));

if (IS_PRODUCTION && PUBLIC_ORIGINS.size === 0) {
  throw new Error('Missing required production variable: TICK_STOREFRONT_ORIGINS');
}
if (IS_PRODUCTION && !path.isAbsolute(String(process.env.TICK_DB_PATH || ''))) {
  throw new Error('TICK_DB_PATH must be an explicit absolute persistent-disk path in production');
}
const HTML_CANDIDATES = [
  process.env.TICK_HTML,
  path.join(__dirname, '..', 'public', 'index.html'),
  path.join(__dirname, '..', 'tick-website-v26-final.html'),
].filter(Boolean);
const HTML_PATH = HTML_CANDIDATES.find((p) => fs.existsSync(p)) || HTML_CANDIDATES[0];

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim() ||
  (IS_PRODUCTION ? '' : 'https://baojwaqmriuxcnztixmr.supabase.co');
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || '').trim() ||
  (IS_PRODUCTION ? '' : 'sb_publishable_mNK6WYCml8BeBiO5GcKtmw_jNgklhdi');

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (IS_PRODUCTION) {
  if (!SUPABASE_URL) {
    throw new Error('Missing required production variable: SUPABASE_URL');
  }
  if (SUPABASE_ANON_KEY.length < 20) {
    throw new Error('SUPABASE_ANON_KEY must be a valid publishable key in production');
  }
  let parsedSupabaseUrl;
  try {
    parsedSupabaseUrl = new URL(SUPABASE_URL);
  } catch {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL in production');
  }
  if (parsedSupabaseUrl.protocol !== 'https:') {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL in production');
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing required production variable: SUPABASE_SERVICE_ROLE_KEY');
  }
}

const sbAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

const db = dbApi.openDb();
seedIfEmpty(db, dbApi);

const SUPABASE_PAGE_SIZE = 1000;
const INSTAPAY_PROOF_BUCKET = 'instapay-proofs';
const INSTAPAY_MAX_PROOF_BYTES = 5 * 1024 * 1024;
const PRODUCT_IMAGE_BUCKET = 'product-images';
const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTAPAY_PROOF_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
const PRODUCT_IMAGE_TYPES = new Map(INSTAPAY_PROOF_TYPES);

const PUBLIC_SETTING_DEFAULTS = Object.freeze({
  cod: true,
  instapay: false,
  currency: 'EGP',
  storeName: 'TICK.',
  storeEmail: 'hello@tick.eg',
  waNum: '',
  dropDay: 'Monday',
  dropTime: '10:00',
  socials: {},
  quizResults: {},
});
const PUBLIC_SETTING_KEYS = new Set(Object.keys(PUBLIC_SETTING_DEFAULTS));
const ADMIN_SETTING_KEYS = new Set(Object.keys(PUBLIC_SETTING_DEFAULTS));

function validatePublicUrl(value, allowedHosts) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return null;
    if (allowedHosts && !allowedHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function validateSetting(key, value) {
  if (!ADMIN_SETTING_KEYS.has(key)) return { error: 'unsupported_setting_key' };
  if (key === 'cod' || key === 'instapay') {
    return typeof value === 'boolean' ? { value } : { error: 'invalid_setting_value' };
  }
  if (key === 'currency') {
    return value === 'EGP' ? { value } : { error: 'invalid_setting_value' };
  }
  if (key === 'storeName') {
    const normalized = sanitizeString(value, 80);
    return normalized ? { value: normalized } : { error: 'invalid_setting_value' };
  }
  if (key === 'storeEmail') {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && normalized.length <= 254
      ? { value: normalized }
      : { error: 'invalid_setting_value' };
  }
  if (key === 'waNum') {
    const normalized = String(value || '').trim();
    return normalized === '' || /^\+?[0-9 ()-]{8,24}$/.test(normalized)
      ? { value: normalized }
      : { error: 'invalid_setting_value' };
  }
  if (key === 'dropDay') {
    return ['Monday', 'Tuesday', 'Wednesday'].includes(value)
      ? { value }
      : { error: 'invalid_setting_value' };
  }
  if (key === 'dropTime') {
    return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
      ? { value }
      : { error: 'invalid_setting_value' };
  }
  if (key === 'socials') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'invalid_setting_value' };
    const allowed = {
      tiktok: ['tiktok.com'],
      instagram: ['instagram.com'],
      youtube: ['youtube.com', 'youtu.be'],
      whatsapp: ['wa.me'],
      facebook: ['facebook.com'],
    };
    if (Object.keys(value).some((name) => !Object.prototype.hasOwnProperty.call(allowed, name))) {
      return { error: 'invalid_setting_value' };
    }
    const socials = {};
    for (const [name, hosts] of Object.entries(allowed)) {
      const url = validatePublicUrl(value[name] || '', hosts);
      if (url === null) return { error: 'invalid_setting_value' };
      socials[name] = url;
    }
    return JSON.stringify(socials).length <= 2500
      ? { value: socials }
      : { error: 'invalid_setting_value' };
  }
  if (key === 'quizResults') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'invalid_setting_value' };
    const encoded = JSON.stringify(value);
    return encoded.length <= 20000 ? { value } : { error: 'invalid_setting_value' };
  }
  return { error: 'unsupported_setting_key' };
}

function mergeKnownSettings(rows) {
  const settings = { ...PUBLIC_SETTING_DEFAULTS, socials: {}, quizResults: {} };
  for (const row of rows || []) {
    if (!row || !PUBLIC_SETTING_KEYS.has(row.key)) continue;
    const checked = validateSetting(row.key, row.value);
    if (!checked.error) settings[row.key] = checked.value;
    else if (row.key === 'cod' || row.key === 'instapay') settings[row.key] = false;
  }
  return settings;
}

function mergePublicSettings(rows) {
  const settings = mergeKnownSettings(rows);
  const instapayEnabled = process.env.TICK_INSTAPAY_ENABLED === 'true';
  settings.instapay = settings.instapay === true && instapayEnabled && !!publicInstapayConfig();
  return settings;
}

function publicInstapayConfig() {
  const recipientName = sanitizeString(
    process.env.TICK_INSTAPAY_RECIPIENT_NAME || '',
    100
  );
  const paymentUrl = String(
    process.env.TICK_INSTAPAY_PAYMENT_URL || ''
  ).trim();
  const qrUrl = String(
    process.env.TICK_INSTAPAY_QR_URL || ''
  ).trim();

  try {
    const parsedPaymentUrl = new URL(paymentUrl);
    if (parsedPaymentUrl.protocol !== 'https:' || !recipientName) return null;

    let safeQrUrl = null;
    if (qrUrl) {
      const parsedQrUrl = new URL(qrUrl);
      if (parsedQrUrl.protocol === 'https:') safeQrUrl = parsedQrUrl.toString();
    }

    return {
      recipient_name: recipientName,
      payment_url: parsedPaymentUrl.toString(),
      qr_url: safeQrUrl,
    };
  } catch {
    return null;
  }
}

if (IS_PRODUCTION && process.env.TICK_INSTAPAY_ENABLED === 'true' && !publicInstapayConfig()) {
  throw new Error('Enabled InstaPay requires TICK_INSTAPAY_RECIPIENT_NAME and a valid HTTPS TICK_INSTAPAY_PAYMENT_URL');
}

function paymentAccessToken(req) {
  const value = req.get('X-Payment-Access-Token');
  return typeof value === 'string' ? value.trim().slice(0, 128) : '';
}

function decodePaymentHeader(req, name, maxLen) {
  const raw = req.get(name);
  if (typeof raw !== 'string') return '';
  try {
    return decodeURIComponent(raw).normalize('NFKC').trim().slice(0, maxLen);
  } catch {
    return '';
  }
}

function normalizePaymentReference(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

function detectedProofExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) return 'png';
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'webp';
  return null;
}

function safeProductImagePayload(image) {
  if (!image || typeof image !== 'object') return null;
  return {
    id: image.id,
    product_id: image.product_id,
    url: image.url,
    position: image.position,
    created_at: image.created_at || null,
  };
}

function isSafeProductImagePath(storagePath, productId) {
  if (typeof storagePath !== 'string' || storagePath.length > 500) return false;
  if (!UUID_PATTERN.test(productId)) return false;
  if (storagePath.includes('..') || storagePath.includes('\\')) return false;
  const escapedProductId = productId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^${escapedProductId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp)$`,
    'i'
  ).test(storagePath);
}

function safeSupabaseErrorCode(error) {
  if (!error || typeof error !== 'object') return 'unknown';
  return sanitizeString(error.code || error.name || error.statusCode || 'unknown', 80) || 'unknown';
}

function logProductImageCleanupWarning(event, context, error) {
  console.warn(JSON.stringify({
    level: 'warning',
    event,
    product_id: context.productId || null,
    image_id: context.imageId || null,
    object_count: Number(context.objectCount) || 0,
    completed_count: Number(context.completedCount) || 0,
    error_code: safeSupabaseErrorCode(error),
  }));
}

async function removeProductImageObjects(storagePaths, context) {
  const uniquePaths = [...new Set(storagePaths)];
  let completedCount = 0;

  for (let offset = 0; offset < uniquePaths.length; offset += 100) {
    const batch = uniquePaths.slice(offset, offset + 100);
    let error = null;
    try {
      ({ error } = await sbAdmin.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .remove(batch));
    } catch (caughtError) {
      error = caughtError;
    }

    if (error) {
      logProductImageCleanupWarning(
        context.event,
        {
          ...context,
          objectCount: uniquePaths.length,
          completedCount,
        },
        error
      );
      return { ok: false, completedCount };
    }
    completedCount += batch.length;
  }

  return { ok: true, completedCount };
}

function instapayRpcError(error) {
  if (!error) return 'payment_action_failed';
  if (error.code === '23505') return 'duplicate_payment_reference';
  const allowed = new Set([
    'invalid_payment_reference',
    'invalid_payment_sender_name',
    'invalid_payment_proof_path',
    'invalid_rejection_reason',
  ]);
  return allowed.has(error.message) ? error.message : 'payment_action_failed';
}

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

const app = express();
if (TRUST_PROXY_HOPS) {
  app.set('trust proxy', TRUST_PROXY_HOPS);
}
app.use(backendSentry.handled5xxMiddleware);
app.use(helmet({
  contentSecurityPolicy: false, // Site is a large SPGA with many inline scripts/styles for now
}));
function isAllowedRequestOrigin(origin) {
  if (!origin) return true;
  if (PUBLIC_ORIGINS.has(origin)) return true;
  if (!IS_PRODUCTION) {
    try {
      const parsed = new URL(origin);
      return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    } catch {
      return false;
    }
  }
  return false;
}
app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedRequestOrigin(origin) ? (origin || false) : false);
  },
  credentials: false,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Payment-Access-Token', 'X-Payment-Reference', 'X-Payment-Sender-Name'],
}));
app.use(cookieParser());
app.use(express.json({ limit: '128kb', strict: true }));
app.use((error, req, res, next) => {
  if (!error) return next();
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'request_body_too_large' });
  if (error instanceof SyntaxError) return res.status(400).json({ error: 'invalid_json' });
  return next(error);
});
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

const proofSubmissionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: { error: 'too_many_proof_attempts' },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminImageMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'too_many_admin_image_requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/api/public/runtime-config', publicApiLimiter, (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  return res.json({
    supabase_url: SUPABASE_URL,
    supabase_publishable_key: SUPABASE_ANON_KEY,
  });
});

app.get('/api/ready', publicApiLimiter, async (req, res) => {
  if (!sbAdmin) {
    return res.status(503).json({ ok: false, status: 'not_ready', dependency: 'supabase' });
  }
  let timeout;
  try {
    const check = sbAdmin.from('settings').select('key').limit(1);
    const result = await Promise.race([
      check,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('readiness_timeout')), 3000);
      }),
    ]);
    if (result.error) throw result.error;
    return res.json({ ok: true, status: 'ready', service: 'tick-store' });
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warning', event: 'readiness_check_failed' }));
    return res.status(503).json({ ok: false, status: 'not_ready', dependency: 'supabase' });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

app.get('/api/public/settings', publicApiLimiter, async (req, res) => {
  if (!sbAdmin) return res.status(503).json({ error: 'settings_unavailable' });
  const { data, error } = await sbAdmin
    .from('settings')
    .select('key, value')
    .in('key', [...PUBLIC_SETTING_KEYS]);
  if (error) {
    console.warn(JSON.stringify({ level: 'warning', event: 'public_settings_read_failed' }));
    return res.status(503).json({ error: 'settings_unavailable' });
  }
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  return res.json({ ok: true, settings: mergePublicSettings(data) });
});

const proofBodyParser = express.raw({
  type: () => true,
  limit: INSTAPAY_MAX_PROOF_BYTES,
});

function parseProofBody(req, res, next) {
  proofBodyParser(req, res, (error) => {
    if (error && error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payment_proof_too_large' });
    }
    if (error) return res.status(400).json({ error: 'invalid_payment_proof' });
    return next();
  });
}

const productImageBodyParser = express.raw({
  type: () => true,
  limit: PRODUCT_IMAGE_MAX_BYTES,
});

function validateProductImageMime(req, res, next) {
  const mime = String(req.get('Content-Type') || '').split(';', 1)[0].toLowerCase();
  if (!PRODUCT_IMAGE_TYPES.has(mime)) {
    return res.status(415).json({ error: 'unsupported_product_image_type' });
  }
  req.productImageMime = mime;
  return next();
}

function parseProductImageBody(req, res, next) {
  productImageBodyParser(req, res, (error) => {
    if (error && error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'product_image_too_large' });
    }
    if (error) return res.status(400).json({ error: 'invalid_product_image' });
    return next();
  });
}

/* ─── Stage 1: health ─── */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'alive',
    service: 'tick-store',
    time: new Date().toISOString(),
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
    req.admin = jwt.verify(h.slice(7), JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    if (!req.admin || req.admin.role !== 'admin') {
      return res.status(401).json({ error: 'invalid_token' });
    }
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}
app.post('/api/admin/push-token', requireAuth, async (req, res) => {
  try {
    if (process.env.TICK_PUSH_ENABLED !== 'true') {
      return res.status(503).json({ error: 'push_notifications_disabled' });
    }
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
function timingSafeHexEqual(left, right) {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function verifyAdminPassword(password) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024) return false;
  if (parsedAdminPasswordHash) {
    const candidate = crypto.scryptSync(password, parsedAdminPasswordHash.salt, 64);
    return crypto.timingSafeEqual(candidate, parsedAdminPasswordHash.digest);
  }
  if (LEGACY_ADMIN_HASH) {
    const candidate = crypto.createHash('sha256').update(LEGACY_PASSWORD_SALT + password).digest('hex');
    return timingSafeHexEqual(candidate, LEGACY_ADMIN_HASH);
  }
  if (DEVELOPMENT_ADMIN_PASSWORD) {
    const left = crypto.createHash('sha256').update(password).digest();
    const right = crypto.createHash('sha256').update(DEVELOPMENT_ADMIN_PASSWORD).digest();
    return crypto.timingSafeEqual(left, right);
  }
  return false;
}

/* ─── Custom admin auth (Supabase Auth is intentionally not used) ─── */
app.post('/api/auth/login', authLimiter, (req, res) => {
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!verifyAdminPassword(password)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '8h',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  return res.json({ ok: true, token, expiresIn: 8 * 3600 });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, role: req.admin.role });
});

/* ─── InstaPay customer access ───
   checkout_token is generated with crypto.randomUUID() by checkout and is
   used as an unguessable per-order bearer credential. PostgreSQL checks it
   together with the order UUID, so changing only an order ID cannot expose
   or mutate another customer's payment. */
app.get('/api/public/instapay/orders/:id/status', publicApiLimiter, async (req, res) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'invalid_order_id' });
  }

  const accessToken = paymentAccessToken(req);
  if (accessToken.length < 16) {
    return res.status(401).json({ error: 'invalid_payment_access' });
  }
  if (!sbAdmin) {
    return res.status(503).json({ error: 'instapay_not_configured' });
  }

  const { data: order, error } = await sbAdmin.rpc(
    'get_instapay_order_for_customer',
    {
      p_order_id: req.params.id,
      p_checkout_token: accessToken,
    }
  );

  if (error) {
    console.error('InstaPay status lookup failed:', error.message);
    return res.status(500).json({ error: 'payment_status_failed' });
  }
  if (!order) return res.status(404).json({ error: 'order_not_found' });

  return res.json({
    ok: true,
    order,
    payment: publicInstapayConfig(),
  });
});

app.post(
  '/api/public/instapay/orders/:id/proof',
  proofSubmissionLimiter,
  (req, res, next) => {
    const mime = String(req.get('Content-Type') || '').split(';', 1)[0].toLowerCase();
    if (!INSTAPAY_PROOF_TYPES.has(mime)) {
      return res.status(415).json({ error: 'invalid_payment_proof_type' });
    }
    req.proofMime = mime;
    return next();
  },
  parseProofBody,
  async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'invalid_order_id' });
    }

    const accessToken = paymentAccessToken(req);
    if (accessToken.length < 16) {
      return res.status(401).json({ error: 'invalid_payment_access' });
    }

    const reference = normalizePaymentReference(
      decodePaymentHeader(req, 'X-Payment-Reference', 96)
    );
    const senderName = sanitizeString(
      decodePaymentHeader(req, 'X-Payment-Sender-Name', 120),
      100
    ).replace(/\s+/g, ' ');

    if (!/^[A-Z0-9]{6,64}$/.test(reference)) {
      return res.status(400).json({ error: 'invalid_payment_reference' });
    }
    if (senderName.length < 2) {
      return res.status(400).json({ error: 'invalid_payment_sender_name' });
    }
    if (
      !Buffer.isBuffer(req.body) ||
      req.body.length === 0 ||
      req.body.length > INSTAPAY_MAX_PROOF_BYTES
    ) {
      return res.status(400).json({ error: 'invalid_payment_proof' });
    }

    const expectedExtension = INSTAPAY_PROOF_TYPES.get(req.proofMime);
    const actualExtension = detectedProofExtension(req.body);
    if (!actualExtension || actualExtension !== expectedExtension) {
      return res.status(415).json({ error: 'payment_proof_content_mismatch' });
    }
    if (!sbAdmin) {
      return res.status(503).json({ error: 'instapay_not_configured' });
    }

    const { data: currentOrder, error: lookupError } = await sbAdmin.rpc(
      'get_instapay_order_for_customer',
      {
        p_order_id: req.params.id,
        p_checkout_token: accessToken,
      }
    );

    if (lookupError) {
      console.error('InstaPay proof preflight failed:', lookupError.message);
      return res.status(500).json({ error: 'payment_status_failed' });
    }
    if (!currentOrder) return res.status(404).json({ error: 'order_not_found' });
    if (currentOrder.payment_status === 'expired') {
      return res.status(410).json({ error: 'payment_expired', order: currentOrder });
    }
    if (currentOrder.payment_status !== 'pending_payment') {
      return res.status(409).json({ error: 'payment_not_pending', order: currentOrder });
    }

    const proofPath = `orders/${req.params.id}/${crypto.randomUUID()}.${actualExtension}`;
    const { error: uploadError } = await sbAdmin.storage
      .from(INSTAPAY_PROOF_BUCKET)
      .upload(proofPath, req.body, {
        contentType: req.proofMime,
        cacheControl: '0',
        upsert: false,
      });

    if (uploadError) {
      console.error('InstaPay proof upload failed:', uploadError.message);
      return res.status(500).json({ error: 'payment_proof_upload_failed' });
    }

    const removeUploadedProof = async () => {
      try {
        await sbAdmin.storage.from(INSTAPAY_PROOF_BUCKET).remove([proofPath]);
      } catch {
        // Cleanup is best-effort; no proof contents or private path are logged.
      }
    };

    const { data: order, error: submitError } = await sbAdmin.rpc(
      'submit_instapay_payment_proof',
      {
        p_order_id: req.params.id,
        p_checkout_token: accessToken,
        p_reference: reference,
        p_sender_name: senderName,
        p_proof_path: proofPath,
      }
    );

    if (submitError) {
      await removeUploadedProof();
      const errorCode = instapayRpcError(submitError);
      const status = errorCode === 'duplicate_payment_reference' ? 409 : 400;
      return res.status(status).json({ error: errorCode });
    }
    if (!order) {
      await removeUploadedProof();
      return res.status(404).json({ error: 'order_not_found' });
    }
    if (!order.proof_accepted) {
      await removeUploadedProof();
      const status = order.payment_status === 'expired' ? 410 : 409;
      return res.status(status).json({
        error: order.payment_status === 'expired' ? 'payment_expired' : 'payment_not_pending',
        order,
      });
    }

    return res.json({ ok: true, order });
  }
);

/* ─── InstaPay admin actions: existing Express JWT only ─── */
app.post('/api/admin/orders/:id/instapay/confirm', requireAuth, async (req, res) => {
  if (!sbAdmin) return res.status(503).json({ error: 'supabase_admin_not_configured' });
  if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'invalid_order_id' });

  const verifiedBy = sanitizeString(
    req.admin.email || req.admin.sub || req.admin.role || 'admin',
    120
  );
  const { data: order, error } = await sbAdmin.rpc('confirm_instapay_payment', {
    p_order_id: req.params.id,
    p_verified_by: verifiedBy || 'admin',
  });

  if (error) {
    console.error('InstaPay confirmation failed:', error.message);
    return res.status(500).json({ error: 'payment_confirmation_failed' });
  }
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.payment_status !== 'paid') {
    return res.status(409).json({ error: 'payment_not_confirmable', order });
  }
  return res.json({ ok: true, order });
});

app.post('/api/admin/orders/:id/instapay/reject', requireAuth, async (req, res) => {
  if (!sbAdmin) return res.status(503).json({ error: 'supabase_admin_not_configured' });
  if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'invalid_order_id' });

  const reason = sanitizeString(req.body && req.body.reason, 500).replace(/\s+/g, ' ');
  if (reason.length < 2) return res.status(400).json({ error: 'invalid_rejection_reason' });

  const { data: order, error } = await sbAdmin.rpc('reject_instapay_payment', {
    p_order_id: req.params.id,
    p_reason: reason,
  });

  if (error) {
    const errorCode = instapayRpcError(error);
    console.error('InstaPay rejection failed:', errorCode);
    return res.status(errorCode === 'invalid_rejection_reason' ? 400 : 500).json({ error: errorCode });
  }
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.payment_status !== 'rejected') {
    return res.status(409).json({ error: 'payment_not_rejectable', order });
  }
  return res.json({ ok: true, order });
});

app.get('/api/admin/orders/:id/instapay/proof', requireAuth, async (req, res) => {
  if (!sbAdmin) return res.status(503).json({ error: 'supabase_admin_not_configured' });
  if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'invalid_order_id' });

  const { data: order, error } = await sbAdmin
    .from('orders')
    .select('payment_method, payment_proof_path')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) {
    console.error('InstaPay proof lookup failed:', error.message);
    return res.status(500).json({ error: 'payment_proof_lookup_failed' });
  }
  if (!order || order.payment_method !== 'InstaPay' || !order.payment_proof_path) {
    return res.status(404).json({ error: 'payment_proof_not_found' });
  }

  const { data: signed, error: signedError } = await sbAdmin.storage
    .from(INSTAPAY_PROOF_BUCKET)
    .createSignedUrl(order.payment_proof_path, 60);

  if (signedError || !signed || !signed.signedUrl) {
    console.error('InstaPay proof signing failed:', signedError && signedError.message);
    return res.status(500).json({ error: 'payment_proof_signing_failed' });
  }

  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, url: signed.signedUrl, expiresIn: 60 });
});

/* ─── Stage 3: admin dashboard + local-only KV ───
   /api/public/bootstrap used to serve products/archive/straps/episodes/
   settings from this same local dbApi store, but index.html has no
   remaining caller for it — the storefront hydrates all of those straight
   from Supabase now (__tickBootstrapFromApi() / sbGetProducts() etc in
   supabase-client.js), so this route was removed as dead code rather than
   left to silently drift out of sync with the real data. ─── */

// Only drops/audit remain here: everything else this set used to gate
// (products, archive, straps, episodes, settings, orders, customers,
// subscribers, notify_me) is Supabase's responsibility now — see
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
  // Orders/customers/subscribers/notify_me/settings all now live in
  // Supabase — the frontend writes them there directly (sbCreateOrder,
  // sbSubscribeEmail, the raw sbClient insert for notify_me,
  // sbSaveProduct/sbSaveSetting/etc). Reading them back from this local
  // dbApi store, as this endpoint used to, meant admin almost never saw real
  // customer activity: a customer's own browser has no tick_api_token, so
  // none of a real customer's checkout/notify-me/newsletter writes
  // ever reached the Express-side store to begin with — only drops/audit
  // (no Supabase table by design) still come from dbApi below.
  if (!sbAdmin) {
    return res.status(503).json({ error: 'supabase_admin_not_configured' });
  }

  try {
    // Read paths also enforce the database deadline. pg_cron is authoritative
    // in the background; this closes any gap if a scheduled run was delayed.
    const { error: expiryError } = await sbAdmin.rpc('expire_instapay_orders');
    if (expiryError) throw expiryError;

    const [orderRows, subscriberRows, notifyRows, settingRows] = await Promise.all([
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
      paymentReference: row.payment_reference || '',
      paymentSenderName: row.payment_sender_name || '',
      paymentProofAvailable: !!row.payment_proof_path,
      paymentSubmittedAt: row.payment_submitted_at || null,
      paymentExpiresAt: row.payment_expires_at || null,
      paymentVerifiedAt: row.payment_verified_at || null,
      paymentRejectedAt: row.payment_rejected_at || null,
      paymentRejectionReason: row.payment_rejection_reason || '',
      stockRestoredAt: row.stock_restored_at || null,
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

    const settings = mergeKnownSettings(settingRows);

    res.json({
      orders,
      customers: Array.from(customersByPhone.values()),
      subscribers,
      notify_me,
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
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: 'invalid_order_id' });
  }

  const status = sanitizeString(req.body && req.body.status, 20).toLowerCase();
  const allowed = new Set(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded']);

  if (!allowed.has(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }

  if (status === 'refunded') {
    return res.status(409).json({ error: 'refund_requires_dedicated_workflow' });
  }

  if (status === 'cancelled') {
    const { data: cancelledOrder, error: cancelError } = await sbAdmin.rpc(
      'cancel_order_with_stock',
      {
        p_order_id: req.params.id,
        p_expected_payment_method: null,
      }
    );

    if (cancelError) {
      const knownCancellationErrors = new Set([
        'order_items_missing',
        'order_stock_restore_unavailable',
        'order_stock_restore_failed',
      ]);
      const errorCode = knownCancellationErrors.has(cancelError.message)
        ? cancelError.message
        : 'order_cancellation_failed';
      console.error('order cancellation error', errorCode);
      return res.status(errorCode === 'order_cancellation_failed' ? 500 : 409).json({ error: errorCode });
    }

    if (!cancelledOrder) return res.status(404).json({ error: 'order_not_found' });

    if (cancelledOrder.reason && cancelledOrder.reason !== 'already_cancelled') {
      return res.status(409).json({ error: cancelledOrder.reason, order: cancelledOrder });
    }

    return res.json({ ok: true, order: cancelledOrder });
  }

  const { data, error } = await sbAdmin.rpc('update_order_fulfillment_status', {
    p_order_id: req.params.id,
    p_status: status,
  });

  if (error) {
    console.error('order status update error', error.message);
    return res.status(500).json({ error: 'order_status_update_failed' });
  }

  if (!data) return res.status(404).json({ error: 'order_not_found' });
  if (data.reason && data.reason !== 'already_in_status') {
    return res.status(409).json({ error: data.reason, order: data });
  }
  return res.json({ ok: true, order: data });
});

const EPISODE_FIELDS = new Set([
  'episode_number', 'title_en', 'title_ar', 'description_en', 'description_ar',
  'category', 'duration', 'video_url',
]);

function validateEpisodePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'invalid_episode' };
  if (Object.keys(input).some((key) => !EPISODE_FIELDS.has(key))) return { error: 'unsupported_episode_field' };
  const episodeNumber = Number(input.episode_number);
  const titleEn = sanitizeString(input.title_en, 240);
  const titleAr = sanitizeString(input.title_ar, 240);
  const descriptionEn = sanitizeString(input.description_en, 5000);
  const descriptionAr = sanitizeString(input.description_ar, 5000);
  const category = sanitizeString(input.category, 40).toLowerCase();
  const duration = sanitizeString(input.duration, 20);
  const videoUrl = String(input.video_url || '').trim();
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > 10000) return { error: 'invalid_episode_number' };
  if (!titleEn || !titleAr) return { error: 'invalid_episode_title' };
  if (!['basics', 'brands', 'buying', 'investment', 'style'].includes(category)) return { error: 'invalid_episode_category' };
  if (duration && !/^\d{1,3}:[0-5]\d$/.test(duration)) return { error: 'invalid_episode_duration' };
  if (videoUrl && validatePublicUrl(videoUrl) === null) return { error: 'invalid_episode_video_url' };
  return {
    episode: {
      episode_number: episodeNumber,
      title_en: titleEn,
      title_ar: titleAr,
      description_en: descriptionEn || null,
      description_ar: descriptionAr || null,
      category,
      duration: duration || null,
      video_url: videoUrl ? validatePublicUrl(videoUrl) : null,
    },
  };
}

app.post('/api/admin/episodes', requireAuth, async (req, res) => {
  if (!sbAdmin) return res.status(503).json({ error: 'supabase_admin_not_configured' });
  const checked = validateEpisodePayload(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { data, error } = await sbAdmin.from('episodes').insert([checked.episode]).select().single();
  if (error) {
    console.warn(JSON.stringify({ level: 'warning', event: 'admin_episode_create_failed' }));
    return res.status(500).json({ error: 'episode_create_failed' });
  }
  return res.status(201).json({ ok: true, episode: data });
});

app.patch('/api/admin/episodes/:id', requireAuth, async (req, res) => {
  if (!sbAdmin) return res.status(503).json({ error: 'supabase_admin_not_configured' });
  if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'invalid_episode_id' });
  const checked = validateEpisodePayload(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { data, error } = await sbAdmin
    .from('episodes')
    .update(checked.episode)
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) {
    console.warn(JSON.stringify({ level: 'warning', event: 'admin_episode_update_failed' }));
    return res.status(500).json({ error: 'episode_update_failed' });
  }
  if (!data) return res.status(404).json({ error: 'episode_not_found' });
  return res.json({ ok: true, episode: data });
});

app.delete('/api/admin/episodes/:id', requireAuth, async (req, res) => {
  if (!sbAdmin) return res.status(503).json({ error: 'supabase_admin_not_configured' });
  if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'invalid_episode_id' });
  const { data, error } = await sbAdmin
    .from('episodes')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .maybeSingle();
  if (error) {
    console.warn(JSON.stringify({ level: 'warning', event: 'admin_episode_delete_failed' }));
    return res.status(500).json({ error: 'episode_delete_failed' });
  }
  if (!data) return res.status(404).json({ error: 'episode_not_found' });
  return res.json({ ok: true, deleted: true, id: data.id });
});

const PRODUCT_FIELDS = new Set([
  'brand', 'name', 'price', 'sale_price', 'stock_quantity', 'category_id',
  'force_out_of_stock', 'movement', 'case_size', 'crystal', 'water_resistance',
  'strap_type', 'power_reserve', 'description_en', 'description_ar', 'variants',
  'era', 'condition_rating', 'orig_price_reference', 'authentication_notes',
  'emoji', 'bg_color', 'tags', 'size', 'video_url', 'model_3d_url', 'is_active',
]);
function validateProductPayload(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  if (Object.keys(body).some((key) => !PRODUCT_FIELDS.has(key))) {
    return { error: 'unsupported_product_field' };
  }

  const brand = sanitizeString(body.brand, 120);
  const name = sanitizeString(body.name, 200);
  const price = Number(body.price);
  const salePrice =
  body.sale_price === null ||
  body.sale_price === undefined ||
  body.sale_price === ''
    ? null
    : Number(body.sale_price);
  const stockQuantity = Number(body.stock_quantity);
  let categoryId = null;

if (
  body.category_id !== null &&
  body.category_id !== undefined &&
  body.category_id !== ''
) {
  categoryId = String(body.category_id);

  if (!UUID_PATTERN.test(categoryId)) {
    return { error: 'invalid_product_category' };
  }
}

  if (!brand) return { error: 'invalid_product_brand' };
  if (!name) return { error: 'invalid_product_name' };

  if (!Number.isFinite(price) || price <= 0) {
    return { error: 'invalid_product_price' };
  }
if (
  salePrice !== null &&
  (!Number.isFinite(salePrice) ||
    salePrice < 0 ||
    salePrice >= price)
) {
  return { error: 'invalid_product_sale_price' };
}
  if (!Number.isInteger(stockQuantity) || stockQuantity < 0) {
    return { error: 'invalid_product_stock' };
  }
let conditionRating = null;

if (
  body.condition_rating !== null &&
  body.condition_rating !== undefined &&
  body.condition_rating !== ''
) {
  conditionRating = Number(body.condition_rating);

  if (
    !Number.isInteger(conditionRating) ||
    conditionRating < 1 ||
    conditionRating > 5
  ) {
    return { error: 'invalid_condition_rating' };
  }
}

let originalPriceReference = null;

if (
  body.orig_price_reference !== null &&
  body.orig_price_reference !== undefined &&
  body.orig_price_reference !== ''
) {
  originalPriceReference = Number(body.orig_price_reference);

  if (
    !Number.isFinite(originalPriceReference) ||
    originalPriceReference < 0
  ) {
    return { error: 'invalid_original_price_reference' };
  }
}
  const emoji = sanitizeString(body.emoji, 24) || null;
  const bgColor = String(body.bg_color || '').trim();
  if (bgColor && !/^#[0-9a-f]{6}$/i.test(bgColor)) return { error: 'invalid_product_color' };
  const tags = body.tags === undefined ? [] : body.tags;
  if (!Array.isArray(tags) || tags.length > 10 || tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9_-]{1,30}$/i.test(tag))) {
    return { error: 'invalid_product_tags' };
  }
  if (body.variants !== undefined) {
    const isPlainObject = body.variants && !Array.isArray(body.variants) && Object.getPrototypeOf(body.variants) === Object.prototype;
    if (!Array.isArray(body.variants) && !isPlainObject) return { error: 'invalid_product_variants' };
    if (JSON.stringify(body.variants).length > 20000) return { error: 'invalid_product_variants' };
  }
  const videoUrl = String(body.video_url || '').trim();
  const modelUrl = String(body.model_3d_url || '').trim();
  if (videoUrl && validatePublicUrl(videoUrl) === null) return { error: 'invalid_product_video_url' };
  if (modelUrl && validatePublicUrl(modelUrl) === null) return { error: 'invalid_product_model_url' };
  if (body.is_active !== undefined && typeof body.is_active !== 'boolean') return { error: 'invalid_product_active_state' };
  return {
    product: {
      brand,
      name,
      price,
      sale_price: salePrice,
      stock_quantity: stockQuantity,
      category_id: categoryId,
      force_out_of_stock: body.force_out_of_stock === true,
emoji,
bg_color: bgColor || null,
tags: [...new Set(tags.map((tag) => tag.toLowerCase()))],
size: sanitizeString(body.size, 60) || null,
movement: sanitizeString(body.movement, 100) || null,
case_size: sanitizeString(body.case_size, 100) || null,
crystal: sanitizeString(body.crystal, 100) || null,
water_resistance: sanitizeString(body.water_resistance, 100) || null,
strap_type: sanitizeString(body.strap_type, 150) || null,
power_reserve: sanitizeString(body.power_reserve, 150) || null,
description_en: sanitizeString(body.description_en, 10000) || null,
description_ar: sanitizeString(body.description_ar, 10000) || null,
variants:
  body.variants === undefined ? [] : body.variants,
video_url: videoUrl ? validatePublicUrl(videoUrl) : null,
model_3d_url: modelUrl ? validatePublicUrl(modelUrl) : null,
is_active: body.is_active === undefined ? true : body.is_active,
    era: sanitizeString(body.era, 100) || null,
condition_rating: conditionRating,
orig_price_reference: originalPriceReference,
authentication_notes:
  sanitizeString(body.authentication_notes, 5000) || null,
    },
  };
}
app.post('/api/admin/products', requireAuth, async (req, res) => {
  if (!sbAdmin) {
    return res.status(503).json({
      error: 'supabase_admin_not_configured',
    });
  }

  const validated = validateProductPayload(req.body);

  if (validated.error) {
    return res.status(400).json({
      error: validated.error,
    });
  }

  const { data, error } = await sbAdmin
    .from('products')
    .insert([validated.product])
    .select()
    .single();

  if (error) {
    console.error('product create error', error);

    return res.status(500).json({
      error: 'product_create_failed',
    });
  }

  return res.status(201).json({
    ok: true,
    product: data,
  });
});
app.patch('/api/admin/products/:id', requireAuth, async (req, res) => {
  if (!sbAdmin) {
    return res.status(503).json({
      error: 'supabase_admin_not_configured',
    });
  }

  const productId = String(req.params.id || '');

  if (!UUID_PATTERN.test(productId)) {
    return res.status(400).json({
      error: 'invalid_product_id',
    });
  }

  const validated = validateProductPayload(req.body);

  if (validated.error) {
    return res.status(400).json({
      error: validated.error,
    });
  }

  const { data, error } = await sbAdmin
    .from('products')
    .update(validated.product)
    .eq('id', productId)
    .select()
    .maybeSingle();

  if (error) {
    console.error('product update error', error);

    return res.status(500).json({
      error: 'product_update_failed',
    });
  }

  if (!data) {
    return res.status(404).json({
      error: 'product_not_found',
    });
  }

  return res.json({
    ok: true,
    product: data,
  });
});

app.post(
  '/api/admin/products/:id/images',
  requireAuth,
  adminImageMutationLimiter,
  validateProductImageMime,
  parseProductImageBody,
  async (req, res) => {
    if (!sbAdmin) {
      return res.status(503).json({ error: 'supabase_admin_not_configured' });
    }

    const productId = String(req.params.id || '');
    if (!UUID_PATTERN.test(productId)) {
      return res.status(400).json({ error: 'invalid_product_id' });
    }
    if (
      !Buffer.isBuffer(req.body) ||
      req.body.length === 0 ||
      req.body.length > PRODUCT_IMAGE_MAX_BYTES
    ) {
      return res.status(400).json({ error: 'invalid_product_image' });
    }

    const expectedExtension = PRODUCT_IMAGE_TYPES.get(req.productImageMime);
    const actualExtension = detectedProofExtension(req.body);
    if (!actualExtension || actualExtension !== expectedExtension) {
      return res.status(415).json({ error: 'product_image_content_mismatch' });
    }

    const { data: product, error: productError } = await sbAdmin
      .from('products')
      .select('id, is_active')
      .eq('id', productId)
      .maybeSingle();

    if (productError) {
      console.error('product image product lookup failed', safeSupabaseErrorCode(productError));
      return res.status(500).json({ error: 'product_image_product_lookup_failed' });
    }
    if (!product) return res.status(404).json({ error: 'product_not_found' });
    if (product.is_active !== true) {
      return res.status(409).json({ error: 'product_inactive' });
    }

    const storagePath = `${productId}/${crypto.randomUUID()}.${actualExtension}`;
    let uploadError = null;
    try {
      ({ error: uploadError } = await sbAdmin.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .upload(storagePath, req.body, {
          contentType: req.productImageMime,
          cacheControl: '31536000',
          upsert: false,
        }));
    } catch (caughtError) {
      uploadError = caughtError;
    }

    if (uploadError) {
      console.error('product image storage upload failed', safeSupabaseErrorCode(uploadError));
      return res.status(502).json({ error: 'product_image_upload_failed' });
    }

    const publicUrlResult = sbAdmin.storage
      .from(PRODUCT_IMAGE_BUCKET)
      .getPublicUrl(storagePath);
    const publicUrl = publicUrlResult && publicUrlResult.data
      ? publicUrlResult.data.publicUrl
      : '';

    if (!publicUrl) {
      const cleanup = await removeProductImageObjects([storagePath], {
        event: 'product_image_url_cleanup_failed',
        productId,
      });
      return res.status(500).json({
        error: 'product_image_url_failed',
        cleanup_failed: !cleanup.ok,
      });
    }

    const { data: image, error: imageError } = await sbAdmin.rpc(
      'insert_product_image_admin',
      {
        p_product_id: productId,
        p_url: publicUrl,
        p_storage_path: storagePath,
      }
    );

    if (imageError || !image) {
      const cleanup = await removeProductImageObjects([storagePath], {
        event: 'product_image_insert_cleanup_failed',
        productId,
      });
      const knownError = imageError && imageError.message;
      if (knownError === 'product_not_found') {
        return res.status(404).json({ error: 'product_not_found', cleanup_failed: !cleanup.ok });
      }
      if (knownError === 'product_inactive') {
        return res.status(409).json({ error: 'product_inactive', cleanup_failed: !cleanup.ok });
      }
      console.error('product image database insert failed', safeSupabaseErrorCode(imageError));
      return res.status(500).json({
        error: 'product_image_database_insert_failed',
        cleanup_failed: !cleanup.ok,
      });
    }

    return res.status(201).json({
      ok: true,
      image: safeProductImagePayload(image),
    });
  }
);

app.delete(
  '/api/admin/product-images/:id',
  requireAuth,
  adminImageMutationLimiter,
  async (req, res) => {
    if (!sbAdmin) {
      return res.status(503).json({ error: 'supabase_admin_not_configured' });
    }

    const imageId = String(req.params.id || '');
    if (!UUID_PATTERN.test(imageId)) {
      return res.status(400).json({ error: 'invalid_product_image_id' });
    }

    const { data: imageRow, error: lookupError } = await sbAdmin
      .from('product_images')
      .select('id, product_id, storage_path')
      .eq('id', imageId)
      .maybeSingle();

    if (lookupError) {
      console.error('product image lookup failed', safeSupabaseErrorCode(lookupError));
      return res.status(500).json({ error: 'product_image_lookup_failed' });
    }
    if (!imageRow) return res.json({ ok: true, deleted: false });

    const productId = String(imageRow.product_id || '');
    const { data: relatedProduct, error: productLookupError } = await sbAdmin
      .from('products')
      .select('id')
      .eq('id', productId)
      .maybeSingle();

    if (productLookupError) {
      console.error('product image relationship lookup failed', safeSupabaseErrorCode(productLookupError));
      return res.status(500).json({ error: 'product_image_relationship_lookup_failed' });
    }
    if (!relatedProduct || !isSafeProductImagePath(imageRow.storage_path, productId)) {
      return res.status(409).json({ error: 'product_image_cleanup_unavailable' });
    }

    const { data: manifest, error: removeRowError } = await sbAdmin.rpc(
      'delete_product_image_admin',
      { p_image_id: imageId }
    );

    if (removeRowError) {
      console.error('product image database removal failed', safeSupabaseErrorCode(removeRowError));
      return res.status(500).json({ error: 'product_image_database_delete_failed' });
    }
    if (!manifest || manifest.found === false) {
      return res.json({ ok: true, deleted: false });
    }

    const manifestProductId = String(manifest.product_id || '');
    const manifestPath = manifest.storage_path;
    if (
      manifestProductId !== productId ||
      !isSafeProductImagePath(manifestPath, manifestProductId)
    ) {
      logProductImageCleanupWarning(
        'product_image_manifest_invalid',
        { productId, imageId, objectCount: 1 },
        { code: 'invalid_manifest' }
      );
      return res.status(500).json({
        error: 'image_deleted_storage_cleanup_failed',
        image_deleted: true,
      });
    }

    const cleanup = await removeProductImageObjects([manifestPath], {
      event: 'product_image_storage_cleanup_failed',
      productId,
      imageId,
    });
    if (!cleanup.ok) {
      return res.status(500).json({
        error: 'image_deleted_storage_cleanup_failed',
        image_deleted: true,
      });
    }

    return res.json({ ok: true, deleted: true, image_id: imageId });
  }
);

app.put(
  '/api/admin/products/:id/images/order',
  requireAuth,
  adminImageMutationLimiter,
  async (req, res) => {
    if (!sbAdmin) {
      return res.status(503).json({ error: 'supabase_admin_not_configured' });
    }

    const productId = String(req.params.id || '');
    if (!UUID_PATTERN.test(productId)) {
      return res.status(400).json({ error: 'invalid_product_id' });
    }

    const imageIds = req.body && Array.isArray(req.body.image_ids)
      ? req.body.image_ids.map((value) => String(value))
      : null;
    if (!imageIds || imageIds.length > 100 || imageIds.some((id) => !UUID_PATTERN.test(id))) {
      return res.status(400).json({ error: 'invalid_product_image_order' });
    }
    if (new Set(imageIds).size !== imageIds.length) {
      return res.status(400).json({ error: 'duplicate_product_image_id' });
    }

    const { data: product, error: productError } = await sbAdmin
      .from('products')
      .select('id')
      .eq('id', productId)
      .maybeSingle();
    if (productError) {
      console.error('product image reorder product lookup failed', safeSupabaseErrorCode(productError));
      return res.status(500).json({ error: 'product_image_product_lookup_failed' });
    }
    if (!product) return res.status(404).json({ error: 'product_not_found' });

    const { data: currentRows, error: imageLookupError } = await sbAdmin
      .from('product_images')
      .select('id, product_id')
      .eq('product_id', productId);
    if (imageLookupError) {
      console.error('product image reorder lookup failed', safeSupabaseErrorCode(imageLookupError));
      return res.status(500).json({ error: 'product_image_lookup_failed' });
    }

    const currentIds = new Set((currentRows || []).map((row) => String(row.id)));
    if (
      currentIds.size !== imageIds.length ||
      imageIds.some((id) => !currentIds.has(id))
    ) {
      return res.status(409).json({ error: 'product_image_set_mismatch' });
    }

    const { data: reorderedRows, error: reorderError } = await sbAdmin.rpc(
      'reorder_product_images_admin',
      {
        p_product_id: productId,
        p_image_ids: imageIds,
      }
    );
    if (reorderError) {
      const knownErrors = new Set([
        'product_not_found',
        'duplicate_product_image_id',
        'product_image_set_mismatch',
      ]);
      const errorCode = knownErrors.has(reorderError.message)
        ? reorderError.message
        : 'product_image_reorder_failed';
      const status = errorCode === 'product_not_found'
        ? 404
        : errorCode === 'product_image_reorder_failed' ? 500 : 409;
      if (status === 500) {
        console.error('product image reorder failed', safeSupabaseErrorCode(reorderError));
      }
      return res.status(status).json({ error: errorCode });
    }

    return res.json({
      ok: true,
      images: (reorderedRows || []).map(safeProductImagePayload),
    });
  }
);

app.delete(
  '/api/admin/products/:id',
  requireAuth,
  adminImageMutationLimiter,
  async (req, res) => {
    if (!sbAdmin) {
      return res.status(503).json({ error: 'supabase_admin_not_configured' });
    }

    const productId = String(req.params.id || '');
    if (!UUID_PATTERN.test(productId)) {
      return res.status(400).json({ error: 'invalid_product_id' });
    }

    const { data: manifest, error: productDeleteError } = await sbAdmin.rpc(
      'delete_product_admin',
      { p_product_id: productId }
    );

    if (productDeleteError) {
      const protectedErrors = new Set([
        'product_has_unsettled_order',
        'product_has_unsettled_instapay_order',
      ]);
      if (protectedErrors.has(productDeleteError.message)) {
        return res.status(409).json({ error: 'product_has_unsettled_order' });
      }
      if (
        productDeleteError.message === 'product_image_storage_path_missing' ||
        productDeleteError.message === 'product_image_storage_path_unsafe'
      ) {
        return res.status(409).json({ error: 'product_image_cleanup_unavailable' });
      }
      console.error('product database deletion failed', safeSupabaseErrorCode(productDeleteError));
      return res.status(500).json({ error: 'product_delete_failed' });
    }
    if (!manifest || manifest.found === false) {
      return res.status(404).json({ error: 'product_not_found' });
    }

    const storagePaths = Array.isArray(manifest.storage_paths)
      ? manifest.storage_paths
      : [];
    const imageCount = Number(manifest.image_count) || 0;
    if (
      storagePaths.length !== imageCount ||
      storagePaths.some((storagePath) => !isSafeProductImagePath(storagePath, productId))
    ) {
      logProductImageCleanupWarning(
        'product_delete_manifest_invalid',
        { productId, objectCount: imageCount },
        { code: 'invalid_manifest' }
      );
      return res.status(500).json({
        error: 'product_deleted_storage_cleanup_failed',
        product_deleted: true,
      });
    }

    const cleanup = await removeProductImageObjects(storagePaths, {
      event: 'product_delete_storage_cleanup_failed',
      productId,
    });
    if (!cleanup.ok) {
      return res.status(500).json({
        error: 'product_deleted_storage_cleanup_failed',
        product_deleted: true,
      });
    }

    return res.json({
      ok: true,
      deleted: true,
      product_id: productId,
      removed_image_count: imageCount,
    });
  }
);

async function saveAdminSettings(req, res, entries) {
  if (!sbAdmin) {
    return res.status(503).json({
      error: 'supabase_admin_not_configured',
    });
  }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > ADMIN_SETTING_KEYS.size) {
    return res.status(400).json({ error: 'invalid_settings_payload' });
  }
  const seen = new Set();
  const rows = [];
  for (const entry of entries) {
    const key = entry && typeof entry.key === 'string' ? entry.key : '';
    if (seen.has(key)) return res.status(400).json({ error: 'duplicate_setting_key' });
    seen.add(key);
    const checked = validateSetting(key, entry && entry.value);
    if (checked.error) return res.status(400).json({ error: checked.error, key });
    rows.push({ key, value: checked.value, updated_at: new Date().toISOString() });
  }
  const { data, error } = await sbAdmin
    .from('settings')
    .upsert(rows, { onConflict: 'key' })
    .select()
    .order('key', { ascending: true });

  if (error) {
    console.warn(JSON.stringify({ level: 'warning', event: 'admin_settings_save_failed' }));

    return res.status(500).json({
      error: 'setting_save_failed',
    });
  }

  return res.json({
    ok: true,
    settings: data || [],
  });
}

app.put('/api/admin/settings', requireAuth, async (req, res) => {
  const settings = req.body && req.body.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: 'invalid_settings_payload' });
  }
  const keys = Object.keys(settings);
  if (keys.some((key) => !ADMIN_SETTING_KEYS.has(key))) {
    return res.status(400).json({ error: 'unsupported_setting_key' });
  }
  return saveAdminSettings(req, res, keys.map((key) => ({ key, value: settings[key] })));
});

app.put('/api/admin/settings/:key', requireAuth, async (req, res) => {
  const key = String(req.params.key || '');
  return saveAdminSettings(req, res, [{ key, value: req.body && req.body.value }]);
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

/* The storefront has one order path: the hardened create-order Edge Function.
   The former compatibility endpoint had a different validation/rate policy
   and automatic external side effects, so it is deliberately retired. */
app.post('/api/public/order', publicApiLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(410).json({ error: 'legacy_order_route_disabled' });
});

/* Removed legacy /api/public/newsletter and /api/public/notify routes. Their
   live callers use Supabase directly, so the old local-only shapes had no
   customer-facing call sites and could silently drift from canonical data. */

backendSentry.setupExpressErrorHandler(app);

app.listen(PORT, () => {
  console.log(`TICK API listening on http://127.0.0.1:${PORT}/api/health`);
  if (!htmlExists) console.warn('HTML not found at', HTML_PATH, '(set TICK_HTML)');
});

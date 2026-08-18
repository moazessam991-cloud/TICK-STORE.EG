'use strict';

const Sentry = require('@sentry/node');

const DSN = String(process.env.TICK_SENTRY_DSN || '').trim();
const ENVIRONMENT =
  String(process.env.TICK_SENTRY_ENVIRONMENT || 'preview').trim() || 'preview';

const MAX_SCRUB_DEPTH = 6;

const BEARER_PATTERN =
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;

const EMAIL_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const EGYPTIAN_PHONE_PATTERN =
  /(^|[^\d])(?:(?:\+20|0020)[\s.-]?1[0125](?:[\s.-]?\d){8}|01[0125](?:[\s.-]?\d){8})(?!\d)/g;

const ABSOLUTE_URL_PATTERN =
  /https?:\/\/[^\s"'<>]+/gi;

const NAMED_SECRET_PATTERN =
  /\b(authorization|password|access[_-]?token|payment[_-]?access[_-]?token|tick[_-]?api[_-]?token|tick[_-]?session[_-]?token|transaction[_-]?reference|payment[_-]?reference|instapay[_-]?reference|x[_-]?payment[_-]?(?:reference|access[_-]?token|sender[_-]?name)|sender[_-]?name|proof[_-]?(?:url|path)?)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|password|passwd|cookie|token|email|phone|mobile|address|proof|sendername|customername|transactionreference|paymentreference|instapayreference|formdata|requestbody|responsebody|attachment)/;

const SENSITIVE_EXACT_KEYS = new Set([
  'admin',
  'auth',
  'authentication',
  'body',
  'customer',
  'file',
  'files',
  'fullname',
  'payload',
  'payment',
  'session',
  'shipping',
]);

function normalizeKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);

  return (
    SENSITIVE_EXACT_KEYS.has(normalized) ||
    SENSITIVE_KEY_PATTERN.test(normalized)
  );
}

function sanitizeUrl(value) {
  if (typeof value !== 'string') {
    return '[REDACTED_URL]';
  }

  try {
    const parsed = new URL(value);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '[REDACTED_URL]';
    }

    if (/proof/i.test(parsed.pathname)) {
      return `${parsed.origin}/[REDACTED_PROOF_PATH]`;
    }

    return parsed.origin + parsed.pathname;
  } catch {
    return value
      .replace(/[?#].*$/, '')
      .replace(/proof[^\s]*/gi, '[REDACTED_PROOF_PATH]');
  }
}

function sanitizeString(value) {
  if (typeof value !== 'string') return value;

  return value
    .replace(ABSOLUTE_URL_PATTERN, (url) => sanitizeUrl(url))
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(EGYPTIAN_PHONE_PATTERN, '$1[REDACTED_PHONE]')
    .replace(NAMED_SECRET_PATTERN, '$1$2[REDACTED]');
}

function isPlainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return (
    prototype === null ||
    Object.getPrototypeOf(prototype) === null
  );
}

function scrubValue(value, depth = 0, ancestors = []) {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_SCRUB_DEPTH) {
    return '[REDACTED_DEPTH]';
  }

  if (ancestors.includes(value)) {
    return '[REDACTED_CIRCULAR]';
  }

  const nextAncestors = ancestors.concat([value]);

  if (Array.isArray(value)) {
    return value.map((item) =>
      scrubValue(item, depth + 1, nextAncestors)
    );
  }

  if (!isPlainObject(value)) {
    return '[REDACTED_NON_PLAIN]';
  }

  const clean = {};

  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      clean[key] = '[REDACTED]';
    } else {
      clean[key] = scrubValue(
        value[key],
        depth + 1,
        nextAncestors
      );
    }
  }

  return clean;
}

function beforeSend(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const clean = { ...event };

  /*
   * Backend error monitoring does not need customer identity or
   * request metadata. Remove the entire request as a final boundary;
   * dataCollection also prevents collection at the SDK level.
   */
  delete clean.user;
  delete clean.request;

  if (typeof clean.message === 'string') {
    clean.message = sanitizeString(clean.message);
  }

  if (typeof clean.transaction === 'string') {
    clean.transaction = sanitizeString(clean.transaction);
  }

  for (const key of [
    'exception',
    'stacktrace',
    'extra',
    'contexts',
    'tags',
    'logentry',
    'breadcrumbs',
  ]) {
    if (Object.prototype.hasOwnProperty.call(clean, key)) {
      clean[key] = scrubValue(clean[key]);
    }
  }

  return clean;
}

let initialized = false;

if (DSN) {
  try {
    Sentry.init({
      dsn: DSN,
      environment: ENVIRONMENT,

      sendDefaultPii: false,
      enableLogs: false,

      /*
       * Error monitoring only.
       * No tracing or profiling in this phase.
       */
      tracesSampleRate: 0,

      dataCollection: {
        userInfo: false,
        cookies: false,

        httpHeaders: {
          request: false,
          response: false,
        },

        httpBodies: [],
        urlQueryParams: false,

        graphQL: {
          document: false,
          variables: false,
        },

        genAI: {
          inputs: false,
          outputs: false,
        },

        databaseQueryData: false,
        stackFrameVariables: false,
      },

      beforeSend,
    });

    initialized = Sentry.isInitialized();
  } catch (_error) {
    initialized = false;
    console.warn(
      'Backend Sentry initialization failed; continuing without Sentry.'
    );
  }
}

function shouldHandleExpressError(error) {
  if (!error || typeof error !== 'object') return true;

  const rawStatus =
    error.statusCode ??
    error.status ??
    error.status_code ??
    (error.output && error.output.statusCode);

  const status = Number(rawStatus);

  /*
   * Unknown-status exceptions are treated as server errors.
   * Explicit 4xx errors are not sent.
   */
  return !Number.isFinite(status) || status >= 500;
}

function safeRoutePattern(req) {
  const method =
    req && typeof req.method === 'string'
      ? req.method.toUpperCase()
      : 'UNKNOWN';

  const routePath =
    req &&
    req.route &&
    typeof req.route.path === 'string'
      ? req.route.path
      : null;

  if (!routePath) {
    return `${method} [unknown-route]`;
  }

  const baseUrl =
    req && typeof req.baseUrl === 'string'
      ? req.baseUrl
      : '';

  return `${method} ${baseUrl}${routePath}`;
}

function handled5xxMiddleware(req, res, next) {
  if (!initialized) {
    return next();
  }

  res.once('finish', () => {
    try {
      if (res.statusCode < 500) return;

      if (
        res.locals &&
        res.locals.tickSentryThrownError === true
      ) {
        return;
      }

      const route = safeRoutePattern(req);

      Sentry.withScope((scope) => {
        scope.setLevel('error');
        scope.setTag('tick.error_kind', 'handled_5xx');
        scope.setTag(
          'http.method',
          String(req.method || 'UNKNOWN').toUpperCase()
        );
        scope.setTag('http.route', route);
        scope.setTag(
          'http.status_code',
          String(res.statusCode)
        );

        Sentry.captureMessage(
          `Handled HTTP ${res.statusCode}: ${route}`,
          'error'
        );
      });
    } catch (_error) {
      // Error monitoring must never affect the response.
    }
  });

  return next();
}

function setupExpressErrorHandler(app) {
  if (!initialized) return;

  /*
   * Mark thrown Express errors before Sentry sees them so the
   * response-finish 5xx observer does not create a duplicate event.
   */
  app.use((error, req, res, next) => {
    if (
      shouldHandleExpressError(error) &&
      res &&
      res.locals
    ) {
      res.locals.tickSentryThrownError = true;
    }

    return next(error);
  });

  Sentry.setupExpressErrorHandler(app, {
    shouldHandleError: shouldHandleExpressError,
  });
}

module.exports = {
  handled5xxMiddleware,
  setupExpressErrorHandler,

  /*
   * Exported only so the focused security test can execute the real
   * privacy behavior without duplicating implementation logic.
   */
  _test: {
    beforeSend,
    sanitizeString,
    scrubValue,
    safeRoutePattern,
    shouldHandleExpressError,
    isInitialized: () => initialized,
  },
};

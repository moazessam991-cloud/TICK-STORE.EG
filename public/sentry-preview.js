(function initializePreviewSentry(window, document) {
  'use strict';

  var PREVIEW_HOSTNAME = 'tick-store-preview.onrender.com';
  var LOADER_URL = 'https://js-de.sentry-cdn.com/a412e8ce7488d14f5cdc2ceb68faddb0.min.js';
  var MAX_SCRUB_DEPTH = 6;
  var EXTENSION_URL_PATTERN = /(?:chrome|moz|safari)-extension:\/\//i;
  var DISALLOWED_INTEGRATION_PATTERN = /^(?:BrowserTracing|Replay|Feedback|BrowserProfiling|Profiling)$/i;
  var ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
  var BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
  var JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
  var EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  var EGYPTIAN_PHONE_PATTERN = /(^|[^\d])(?:(?:\+20|0020)[\s.-]?1[0125](?:[\s.-]?\d){8}|01[0125](?:[\s.-]?\d){8})(?!\d)/g;
  var NAMED_SECRET_PATTERN = /\b(authorization|password|access[_-]?token|payment[_-]?access[_-]?token|tick[_-]?api[_-]?token|tick[_-]?session[_-]?token|transaction[_-]?reference|payment[_-]?reference|instapay[_-]?reference|x[_-]?payment[_-]?(?:reference|access[_-]?token|sender[_-]?name)|sender[_-]?name|proof[_-]?(?:url|path)?)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi;
  var SENSITIVE_KEY_PATTERN = /(?:authorization|password|passwd|cookie|token|email|phone|mobile|address|proof|sendername|customername|transactionreference|paymentreference|instapayreference|formdata|requestbody|responsebody|attachment)/;
  var SENSITIVE_EXACT_KEYS = {
    admin: true,
    auth: true,
    authentication: true,
    body: true,
    customer: true,
    file: true,
    files: true,
    fullname: true,
    payload: true,
    payment: true,
    session: true,
    shipping: true
  };

  if (!window || !document || !window.location || window.location.hostname !== PREVIEW_HOSTNAME) return;

  function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function isSensitiveKey(key) {
    var normalized = normalizeKey(key);
    return SENSITIVE_EXACT_KEYS[normalized] === true || SENSITIVE_KEY_PATTERN.test(normalized);
  }

  function isUrlKey(key) {
    var normalized = normalizeKey(key);
    return normalized === 'url' ||
      normalized === 'uri' ||
      normalized === 'href' ||
      normalized === 'from' ||
      normalized === 'to' ||
      normalized === 'referer' ||
      normalized === 'referrer' ||
      normalized === 'filename' ||
      normalized === 'abspath' ||
      normalized.slice(-3) === 'url';
  }

  function sanitizeUrl(value) {
    if (typeof value !== 'string') return '[REDACTED]';
    try {
      var parsed = new window.URL(value, window.location.origin);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[REDACTED_URL]';
      if (/proof/i.test(parsed.pathname)) return parsed.origin + '/[REDACTED_PROOF_PATH]';
      return parsed.origin + parsed.pathname;
    } catch (_error) {
      return sanitizeString(value.replace(/[?#].*$/, ''));
    }
  }

  function sanitizeString(value) {
    if (typeof value !== 'string') return value;
    return value
      .replace(ABSOLUTE_URL_PATTERN, function (url) { return sanitizeUrl(url); })
      .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
      .replace(JWT_PATTERN, '[REDACTED_JWT]')
      .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
      .replace(EGYPTIAN_PHONE_PATTERN, '$1[REDACTED_PHONE]')
      .replace(NAMED_SECRET_PATTERN, '$1$2[REDACTED]');
  }

  function isPlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  }

  function scrubValue(value, depth, ancestors) {
    if (typeof value === 'string') return sanitizeString(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_SCRUB_DEPTH) return '[REDACTED_DEPTH]';
    if (ancestors.indexOf(value) !== -1) return '[REDACTED_CIRCULAR]';

    var nextAncestors = ancestors.concat([value]);
    if (Array.isArray(value)) {
      return value.map(function (item) {
        return scrubValue(item, depth + 1, nextAncestors);
      });
    }
    if (!isPlainObject(value)) return '[REDACTED_NON_PLAIN]';

    var clean = {};
    Object.keys(value).forEach(function (key) {
      if (isSensitiveKey(key)) {
        clean[key] = '[REDACTED]';
      } else if (isUrlKey(key)) {
        clean[key] = sanitizeUrl(value[key]);
      } else {
        clean[key] = scrubValue(value[key], depth + 1, nextAncestors);
      }
    });
    return clean;
  }

  function extensionUrlInFrames(stacktrace) {
    if (!stacktrace || !Array.isArray(stacktrace.frames)) return false;
    return stacktrace.frames.some(function (frame) {
      return frame && typeof frame.filename === 'string' && EXTENSION_URL_PATTERN.test(frame.filename);
    });
  }

  function isExtensionEvent(event) {
    if (event.request && typeof event.request.url === 'string' && EXTENSION_URL_PATTERN.test(event.request.url)) {
      return true;
    }
    if (extensionUrlInFrames(event.stacktrace)) return true;
    var values = event.exception && Array.isArray(event.exception.values) ? event.exception.values : [];
    return values.some(function (exception) {
      return exception && extensionUrlInFrames(exception.stacktrace);
    });
  }

  function sanitizeBreadcrumb(breadcrumb) {
    if (!isPlainObject(breadcrumb)) return null;
    if (typeof breadcrumb.category === 'string' && /^ui\./i.test(breadcrumb.category)) return null;

    var clean = {};
    Object.keys(breadcrumb).forEach(function (key) {
      if (key === 'message') {
        clean.message = sanitizeString(breadcrumb.message);
      } else if (key === 'data') {
        clean.data = scrubValue(breadcrumb.data, 0, []);
      } else if (isUrlKey(key)) {
        clean[key] = sanitizeUrl(breadcrumb[key]);
      } else {
        clean[key] = scrubValue(breadcrumb[key], 0, []);
      }
    });

    if (clean.data && isPlainObject(clean.data)) {
      var sourceUrl = clean.data.url || clean.data.from || clean.data.to;
      if (typeof sourceUrl === 'string' && EXTENSION_URL_PATTERN.test(sourceUrl)) return null;
    }
    return clean;
  }

  function beforeBreadcrumb(breadcrumb) {
    return sanitizeBreadcrumb(breadcrumb);
  }

  function beforeSend(event) {
    if (!event || typeof event !== 'object' || window.location.hostname !== PREVIEW_HOSTNAME) return null;
    if (isExtensionEvent(event)) return null;

    var clean = Object.assign({}, event);
    delete clean.user;

    if (isPlainObject(event.request)) {
      clean.request = Object.assign({}, event.request);
      if (Object.prototype.hasOwnProperty.call(clean.request, 'url')) {
        clean.request.url = sanitizeUrl(clean.request.url);
      }
      delete clean.request.data;
      delete clean.request.cookies;
      delete clean.request.query_string;
      delete clean.request.fragment;
      if (Object.prototype.hasOwnProperty.call(clean.request, 'headers')) {
        clean.request.headers = scrubValue(clean.request.headers, 0, []);
      }
      if (Object.prototype.hasOwnProperty.call(clean.request, 'env')) {
        clean.request.env = scrubValue(clean.request.env, 0, []);
      }
    } else {
      delete clean.request;
    }

    if (typeof clean.message === 'string') clean.message = sanitizeString(clean.message);
    if (typeof clean.transaction === 'string') clean.transaction = sanitizeString(clean.transaction);
    if (Object.prototype.hasOwnProperty.call(clean, 'exception')) {
      clean.exception = scrubValue(clean.exception, 0, []);
    }
    if (Object.prototype.hasOwnProperty.call(clean, 'stacktrace')) {
      clean.stacktrace = scrubValue(clean.stacktrace, 0, []);
    }
    if (Object.prototype.hasOwnProperty.call(clean, 'extra')) {
      clean.extra = scrubValue(clean.extra, 0, []);
    }
    if (Object.prototype.hasOwnProperty.call(clean, 'contexts')) {
      clean.contexts = scrubValue(clean.contexts, 0, []);
    }
    if (Object.prototype.hasOwnProperty.call(clean, 'tags')) {
      clean.tags = scrubValue(clean.tags, 0, []);
    }
    if (Object.prototype.hasOwnProperty.call(clean, 'logentry')) {
      clean.logentry = scrubValue(clean.logentry, 0, []);
    }
    if (Array.isArray(clean.breadcrumbs)) {
      clean.breadcrumbs = clean.breadcrumbs.map(sanitizeBreadcrumb).filter(Boolean);
    }
    return clean;
  }

  function sentryOptions() {
    return {
      environment: 'preview',
      enabled: window.location.hostname === PREVIEW_HOSTNAME,
      sendDefaultPii: false,
      attachStacktrace: true,
      autoSessionTracking: false,
      enableLogs: false,
      autoInjectFeedback: false,
      denyUrls: [
        /^chrome-extension:\/\//i,
        /^moz-extension:\/\//i,
        /^safari-extension:\/\//i
      ],
      integrations: function (defaultIntegrations) {
        return defaultIntegrations.filter(function (integration) {
          return !integration || !DISALLOWED_INTEGRATION_PATTERN.test(integration.name || '');
        });
      },
      beforeBreadcrumb: beforeBreadcrumb,
      beforeSend: beforeSend
    };
  }

  try {
    var loader = document.createElement('script');
    loader.src = LOADER_URL;
    loader.crossOrigin = 'anonymous';
    loader.async = true;
    loader.setAttribute('data-lazy', 'no');
    loader.addEventListener('load', function () {
      try {
        if (!window.Sentry || typeof window.Sentry.onLoad !== 'function') return;
        window.Sentry.onLoad(function () {
          try {
            if (window.Sentry && typeof window.Sentry.init === 'function') {
              window.Sentry.init(sentryOptions());
            }
          } catch (_error) {}
        });
        if (typeof window.Sentry.forceLoad === 'function') window.Sentry.forceLoad();
      } catch (_error) {}
    }, { once: true, passive: true });
    (document.head || document.documentElement).appendChild(loader);
  } catch (_error) {}
}(window, document));

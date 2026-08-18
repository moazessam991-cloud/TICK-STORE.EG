#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const sentryPath = path.join(root, 'server', 'sentry.js');
const serverPath = path.join(root, 'server', 'index.js');

function loadBackendSentry(dsn) {
  const originalLoad = Module._load;
  const originalDsn = process.env.TICK_SENTRY_DSN;
  const originalEnvironment = process.env.TICK_SENTRY_ENVIRONMENT;

  let initOptions;
  let initialized = false;
  let activeScope = null;

  const captures = [];
  const expressSetupCalls = [];

  const sentryStub = {
    init(options) {
      initOptions = options;
      initialized = true;
    },

    isInitialized() {
      return initialized;
    },

    withScope(callback) {
      const state = {
        level: null,
        tags: {},
      };

      const scope = {
        setLevel(level) {
          state.level = level;
        },

        setTag(key, value) {
          state.tags[key] = value;
        },
      };

      const previous = activeScope;
      activeScope = state;

      try {
        return callback(scope);
      } finally {
        activeScope = previous;
      }
    },

    captureMessage(message, level) {
      captures.push({
        message,
        level,
        scope: activeScope
          ? {
              level: activeScope.level,
              tags: { ...activeScope.tags },
            }
          : null,
      });
    },

    setupExpressErrorHandler(app, options) {
      expressSetupCalls.push({ app, options });
    },
  };

  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === '@sentry/node') {
        return sentryStub;
      }

      return originalLoad.call(this, request, parent, isMain);
    };

    if (dsn) {
      process.env.TICK_SENTRY_DSN = dsn;
    } else {
      delete process.env.TICK_SENTRY_DSN;
    }

    process.env.TICK_SENTRY_ENVIRONMENT = 'preview';

    delete require.cache[require.resolve(sentryPath)];

    const backendSentry = require(sentryPath);

    return {
      backendSentry,
      getInitOptions: () => initOptions,
      captures,
      expressSetupCalls,
    };
  } finally {
    Module._load = originalLoad;

    if (originalDsn === undefined) {
      delete process.env.TICK_SENTRY_DSN;
    } else {
      process.env.TICK_SENTRY_DSN = originalDsn;
    }

    if (originalEnvironment === undefined) {
      delete process.env.TICK_SENTRY_ENVIRONMENT;
    } else {
      process.env.TICK_SENTRY_ENVIRONMENT = originalEnvironment;
    }
  }
}

/* No DSN means Sentry stays completely disabled. */
const disabled = loadBackendSentry('');

assert.strictEqual(
  disabled.backendSentry._test.isInitialized(),
  false,
  'backend Sentry initialized without a DSN'
);

let disabledFinishRegistered = false;
let disabledNextCalls = 0;

disabled.backendSentry.handled5xxMiddleware(
  { method: 'GET' },
  {
    statusCode: 500,
    locals: {},
    once() {
      disabledFinishRegistered = true;
    },
  },
  () => {
    disabledNextCalls += 1;
  }
);

assert.strictEqual(disabledNextCalls, 1);
assert.strictEqual(
  disabledFinishRegistered,
  false,
  'disabled Sentry still attached a response observer'
);

/* Fake DSN + stubbed SDK: no network is used. */
const enabled = loadBackendSentry(
  'https://public@example.ingest.sentry.io/123'
);

const backendSentry = enabled.backendSentry;
const options = enabled.getInitOptions();

assert(options, 'Sentry.init was not called when a DSN was configured');
assert.strictEqual(options.environment, 'preview');
assert.strictEqual(options.sendDefaultPii, false);
assert.strictEqual(options.enableLogs, false);
assert.strictEqual(options.tracesSampleRate, 0);

assert.deepStrictEqual(options.dataCollection, {
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
});

assert(
  !Object.prototype.hasOwnProperty.call(options, 'profilesSampleRate'),
  'profiling was unexpectedly enabled'
);

/* Execute the real beforeSend implementation. */
const inputEvent = {
  user: {
    email: 'buyer@example.com',
  },

  request: {
    url: 'https://tick-store-preview.onrender.com/api/test?token=secret',
    headers: {
      Authorization: 'Bearer secret-token',
      Cookie: 'tick_session_token=secret',
    },
    data: {
      phone: '01012345678',
      address: 'Cairo',
    },
  },

  message:
    'Bearer secret-token buyer@example.com 01012345678 payment_reference=PAY-123',

  exception: {
    values: [
      {
        value:
          'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature password=secret',
      },
    ],
  },

  extra: {
    proof_url:
      'https://storage.example/proofs/order.png?token=secret',
    transaction_reference: 'TX-SECRET',
    safe: 42,
  },

  contexts: {
    customer: {
      name: 'Buyer',
      address: 'Cairo',
    },
    runtime: {
      name: 'node',
    },
  },
};

const cleanEvent = options.beforeSend(inputEvent);

assert(
  !Object.prototype.hasOwnProperty.call(cleanEvent, 'user'),
  'event.user was retained'
);

assert(
  !Object.prototype.hasOwnProperty.call(cleanEvent, 'request'),
  'request metadata was retained'
);

assert(cleanEvent.message.includes('Bearer [REDACTED]'));
assert(cleanEvent.message.includes('[REDACTED_EMAIL]'));
assert(cleanEvent.message.includes('[REDACTED_PHONE]'));
assert(cleanEvent.message.includes('payment_reference=[REDACTED]'));

assert(
  cleanEvent.exception.values[0].value.includes('[REDACTED_JWT]')
);

assert(
  cleanEvent.exception.values[0].value.includes('password=[REDACTED]')
);

assert.strictEqual(cleanEvent.extra.proof_url, '[REDACTED]');
assert.strictEqual(
  cleanEvent.extra.transaction_reference,
  '[REDACTED]'
);
assert.strictEqual(cleanEvent.extra.safe, 42);
assert.strictEqual(cleanEvent.contexts.customer, '[REDACTED]');
assert.strictEqual(cleanEvent.contexts.runtime.name, 'node');

const serialized = JSON.stringify(cleanEvent);

for (const sensitive of [
  'buyer@example.com',
  '01012345678',
  'secret-token',
  'PAY-123',
  'TX-SECRET',
  'tick_session_token',
]) {
  assert(
    !serialized.includes(sensitive),
    `sensitive value was retained: ${sensitive}`
  );
}

/* Execute real string sanitizer behavior. */
assert.strictEqual(
  backendSentry._test.sanitizeString('01012345678'),
  '[REDACTED_PHONE]'
);

assert.strictEqual(
  backendSentry._test.sanitizeString('+20 1012345678'),
  '[REDACTED_PHONE]'
);

assert.strictEqual(
  backendSentry._test.sanitizeString('buyer@example.com'),
  '[REDACTED_EMAIL]'
);

assert.strictEqual(
  backendSentry._test.sanitizeString(
    'https://example.com/path?token=secret#fragment'
  ),
  'https://example.com/path'
);

const unrelatedNumbers =
  'Order 1234567890 costs 20260.50 EGP; test port 38486';

assert.strictEqual(
  backendSentry._test.sanitizeString(unrelatedNumbers),
  unrelatedNumbers
);

/* Explicit 4xx errors are ignored; 5xx/unknown exceptions are monitored. */
assert.strictEqual(
  backendSentry._test.shouldHandleExpressError({ status: 400 }),
  false
);

assert.strictEqual(
  backendSentry._test.shouldHandleExpressError({ statusCode: 404 }),
  false
);

assert.strictEqual(
  backendSentry._test.shouldHandleExpressError({ status: 500 }),
  true
);

assert.strictEqual(
  backendSentry._test.shouldHandleExpressError(new Error('boom')),
  true
);

/* Route metadata must use the Express pattern, never the real request URL. */
const safeRoute = backendSentry._test.safeRoutePattern({
  method: 'PUT',
  baseUrl: '/api/admin',
  route: {
    path: '/settings/:key',
  },
  originalUrl:
    '/api/admin/settings/instapay?access_token=SECRET',
});

assert.strictEqual(
  safeRoute,
  'PUT /api/admin/settings/:key'
);

assert(!safeRoute.includes('instapay'));
assert(!safeRoute.includes('SECRET'));

/* A handled 5xx creates only sanitized route/status metadata. */
let finish500;
let next500 = 0;

const request500 = {
  method: 'PUT',
  baseUrl: '/api/admin',
  route: {
    path: '/settings/:key',
  },
  originalUrl:
    '/api/admin/settings/instapay?access_token=SECRET',
};

const response500 = {
  statusCode: 500,
  locals: {},

  once(event, callback) {
    assert.strictEqual(event, 'finish');
    finish500 = callback;
  },
};

backendSentry.handled5xxMiddleware(
  request500,
  response500,
  () => {
    next500 += 1;
  }
);

assert.strictEqual(next500, 1);
assert.strictEqual(typeof finish500, 'function');

const capturesBefore500 = enabled.captures.length;
finish500();

assert.strictEqual(
  enabled.captures.length,
  capturesBefore500 + 1,
  'handled 5xx was not captured'
);

const handledCapture =
  enabled.captures[enabled.captures.length - 1];

assert.strictEqual(
  handledCapture.message,
  'Handled HTTP 500: PUT /api/admin/settings/:key'
);

assert.strictEqual(handledCapture.level, 'error');
assert.strictEqual(handledCapture.scope.level, 'error');

assert.deepStrictEqual(handledCapture.scope.tags, {
  'tick.error_kind': 'handled_5xx',
  'http.method': 'PUT',
  'http.route': 'PUT /api/admin/settings/:key',
  'http.status_code': '500',
});

const captureJson = JSON.stringify(handledCapture);

assert(!captureJson.includes('instapay'));
assert(!captureJson.includes('SECRET'));

/* Normal responses must not generate Sentry events. */
let finish404;

backendSentry.handled5xxMiddleware(
  {
    method: 'GET',
    baseUrl: '',
    route: {
      path: '/api/public/settings',
    },
  },
  {
    statusCode: 404,
    locals: {},

    once(_event, callback) {
      finish404 = callback;
    },
  },
  () => {}
);

const capturesBefore404 = enabled.captures.length;
finish404();

assert.strictEqual(
  enabled.captures.length,
  capturesBefore404,
  '4xx response generated a Sentry event'
);

/* A thrown error marked by the Express error layer must not duplicate as handled 5xx. */
let duplicateFinish;

backendSentry.handled5xxMiddleware(
  {
    method: 'GET',
    route: {
      path: '/api/test',
    },
  },
  {
    statusCode: 500,
    locals: {
      tickSentryThrownError: true,
    },

    once(_event, callback) {
      duplicateFinish = callback;
    },
  },
  () => {}
);

const capturesBeforeDuplicate = enabled.captures.length;
duplicateFinish();

assert.strictEqual(
  enabled.captures.length,
  capturesBeforeDuplicate,
  'thrown error was duplicated by handled-5xx monitoring'
);

/* Verify Express thrown-error integration and duplicate marker. */
const installedErrorMiddleware = [];

const fakeApp = {
  use(middleware) {
    installedErrorMiddleware.push(middleware);
  },
};

backendSentry.setupExpressErrorHandler(fakeApp);

assert.strictEqual(
  enabled.expressSetupCalls.length,
  1,
  'Sentry Express error handler was not installed exactly once'
);

assert.strictEqual(
  installedErrorMiddleware.length,
  1,
  'unexpected custom Express error middleware count'
);

const expressOptions =
  enabled.expressSetupCalls[0].options;

assert.strictEqual(
  expressOptions.shouldHandleError({ status: 400 }),
  false
);

assert.strictEqual(
  expressOptions.shouldHandleError({ status: 500 }),
  true
);

const markerMiddleware = installedErrorMiddleware[0];

const thrown500 = new Error('boom');
thrown500.status = 500;

const thrown500Response = {
  locals: {},
};

let forwarded500;

markerMiddleware(
  thrown500,
  {},
  thrown500Response,
  (error) => {
    forwarded500 = error;
  }
);

assert.strictEqual(forwarded500, thrown500);
assert.strictEqual(
  thrown500Response.locals.tickSentryThrownError,
  true
);

const thrown400 = new Error('bad request');
thrown400.status = 400;

const thrown400Response = {
  locals: {},
};

markerMiddleware(
  thrown400,
  {},
  thrown400Response,
  () => {}
);

assert.strictEqual(
  thrown400Response.locals.tickSentryThrownError,
  undefined
);

/* Verify the three surgical server hooks and their order. */
const serverSource = fs.readFileSync(serverPath, 'utf8');

const requireHook =
  serverSource.indexOf("const backendSentry = require('./sentry');");

const expressRequire =
  serverSource.indexOf("const express = require('express');");

const appCreation =
  serverSource.indexOf('const app = express();');

const handledHook =
  serverSource.indexOf(
    'app.use(backendSentry.handled5xxMiddleware);'
  );

const setupHook =
  serverSource.indexOf(
    'backendSentry.setupExpressErrorHandler(app);'
  );

const listenHook =
  serverSource.indexOf('app.listen(PORT');

assert(requireHook !== -1);
assert(expressRequire !== -1);
assert(requireHook < expressRequire);

assert(appCreation !== -1);
assert(handledHook > appCreation);

assert(setupHook !== -1);
assert(listenHook !== -1);
assert(setupHook < listenHook);

assert.strictEqual(
  (
    serverSource.match(
      /app\.use\(backendSentry\.handled5xxMiddleware\);/g
    ) || []
  ).length,
  1
);

assert.strictEqual(
  (
    serverSource.match(
      /backendSentry\.setupExpressErrorHandler\(app\);/g
    ) || []
  ).length,
  1
);

console.log(
  'backend-sentry-security-test: disabled mode, SDK privacy, redaction, handled 5xx, Express errors, dedupe, and hook order passed'
);

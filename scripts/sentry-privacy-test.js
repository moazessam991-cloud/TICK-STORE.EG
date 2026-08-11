#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'sentry-preview.js'), 'utf8');

function loadForHostname(hostname) {
  const scripts = [];
  const document = {
    createElement(tagName) {
      const listeners = {};
      return {
        tagName,
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, listener) { listeners[name] = listener; },
        listeners,
      };
    },
    head: {
      appendChild(script) { scripts.push(script); },
    },
  };
  const window = {
    URL,
    location: {
      hostname,
      origin: `https://${hostname}`,
    },
  };
  vm.runInNewContext(source, { document, window });
  return { scripts, window };
}

for (const hostname of ['localhost', '127.0.0.1', '::1']) {
  const local = loadForHostname(hostname);
  assert.strictEqual(local.scripts.length, 0, `${hostname} loaded the Sentry loader`);
}

const preview = loadForHostname('tick-store-preview.onrender.com');
assert.strictEqual(preview.scripts.length, 1, 'preview did not load Sentry exactly once');
const loader = preview.scripts[0];
assert.strictEqual(loader.src, 'https://js-de.sentry-cdn.com/a412e8ce7488d14f5cdc2ceb68faddb0.min.js');
assert.strictEqual(loader.attributes['data-lazy'], 'no', 'privacy config must be queued before the SDK loads');
const unavailable = loadForHostname('tick-store-preview.onrender.com');
assert.doesNotThrow(() => unavailable.scripts[0].listeners.load(), 'an unavailable Sentry SDK broke startup');

let options;
let onLoadCallback;
const loaderCalls = [];
preview.window.Sentry = {
  onLoad(callback) {
    loaderCalls.push('onLoad');
    onLoadCallback = callback;
  },
  forceLoad() { loaderCalls.push('forceLoad'); },
};
loader.listeners.load();

assert.deepStrictEqual(loaderCalls, ['onLoad', 'forceLoad'], 'onLoad was not registered before forceLoad');
assert.strictEqual(options, undefined, 'Sentry initialized before the real SDK onLoad callback');
preview.window.Sentry.init = function init(value) {
  loaderCalls.push('init');
  options = value;
};
onLoadCallback();
assert.deepStrictEqual(loaderCalls, ['onLoad', 'forceLoad', 'init']);
assert.strictEqual(options.environment, 'preview');
assert.strictEqual(options.enabled, true);
assert.strictEqual(options.sendDefaultPii, false);
assert.strictEqual(options.attachStacktrace, true);
assert.strictEqual(options.autoSessionTracking, false);
assert.strictEqual(options.enableLogs, false);
assert.strictEqual(options.autoInjectFeedback, false);
assert(!Object.prototype.hasOwnProperty.call(options, 'tracesSampleRate'));
assert(!Object.prototype.hasOwnProperty.call(options, 'replaysSessionSampleRate'));
assert(!Object.prototype.hasOwnProperty.call(options, 'replaysOnErrorSampleRate'));
assert(!Object.prototype.hasOwnProperty.call(options, 'release'));

const integrations = options.integrations([
  { name: 'GlobalHandlers' },
  { name: 'BrowserTracing' },
  { name: 'Replay' },
  { name: 'Feedback' },
]);
assert.deepStrictEqual(integrations.map((integration) => integration.name), ['GlobalHandlers']);

assert.strictEqual(options.beforeBreadcrumb({ category: 'ui.click', message: 'checkout' }), null);
const breadcrumbInput = {
  category: 'fetch',
  message: 'Bearer secret-token for buyer@example.com 01012345678',
  data: {
    url: 'https://tick-store-preview.onrender.com/api/public/settings?email=buyer@example.com#secret',
    Authorization: 'Bearer secret-token',
    harmless: 'kept',
  },
};
const breadcrumb = options.beforeBreadcrumb(breadcrumbInput);
assert.strictEqual(breadcrumb.data.url, 'https://tick-store-preview.onrender.com/api/public/settings');
assert.strictEqual(breadcrumb.data.Authorization, '[REDACTED]');
assert.strictEqual(breadcrumb.data.harmless, 'kept');
assert(breadcrumb.message.includes('Bearer [REDACTED]'));
assert(breadcrumb.message.includes('[REDACTED_EMAIL]'));
assert(breadcrumb.message.includes('[REDACTED_PHONE]'));
assert.strictEqual(breadcrumbInput.data.Authorization, 'Bearer secret-token', 'breadcrumb input was mutated');

const circular = { safe: 'kept' };
circular.self = circular;
const eventInput = {
  user: { email: 'buyer@example.com' },
  request: {
    url: 'https://tick-store-preview.onrender.com/checkout?access_token=secret#payment',
    data: new FormData(),
    cookies: { tick_session_token: 'secret' },
    query_string: 'access_token=secret',
    headers: {
      Authorization: 'Bearer secret-token',
      Cookie: 'tick_session_token=secret',
      Referer: 'https://tick-store-preview.onrender.com/checkout?phone=01012345678',
      Accept: 'application/json',
    },
  },
  message: 'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature and buyer@example.com',
  exception: { values: [{ value: 'Call from +20 1012345678 password=secret' }] },
  extra: {
    payment_reference: 'PAY-123',
    proof_url: 'https://storage.example/proofs/order.png?token=secret',
    circular,
    safe: 42,
  },
  contexts: { customer: { name: 'Buyer', address: 'Cairo' }, browser: { name: 'Chrome' } },
  breadcrumbs: [breadcrumbInput, { category: 'ui.input', message: 'typed' }],
};

const clean = options.beforeSend(eventInput);
assert(!Object.prototype.hasOwnProperty.call(clean, 'user'));
assert.strictEqual(clean.request.url, 'https://tick-store-preview.onrender.com/checkout');
assert(!Object.prototype.hasOwnProperty.call(clean.request, 'data'));
assert(!Object.prototype.hasOwnProperty.call(clean.request, 'cookies'));
assert(!Object.prototype.hasOwnProperty.call(clean.request, 'query_string'));
assert.strictEqual(clean.request.headers.Authorization, '[REDACTED]');
assert.strictEqual(clean.request.headers.Cookie, '[REDACTED]');
assert.strictEqual(clean.request.headers.Referer, 'https://tick-store-preview.onrender.com/checkout');
assert.strictEqual(clean.request.headers.Accept, 'application/json');
assert(clean.message.includes('[REDACTED_JWT]'));
assert(clean.message.includes('[REDACTED_EMAIL]'));
assert(clean.exception.values[0].value.includes('[REDACTED_PHONE]'));
assert(clean.exception.values[0].value.includes('password=[REDACTED]'));
assert.strictEqual(clean.extra.payment_reference, '[REDACTED]');
assert.strictEqual(clean.extra.proof_url, '[REDACTED]');
assert.strictEqual(clean.extra.circular.self, '[REDACTED_CIRCULAR]');
assert.strictEqual(clean.extra.safe, 42);
assert.strictEqual(clean.contexts.customer, '[REDACTED]');
assert.strictEqual(clean.contexts.browser.name, 'Chrome');
assert.strictEqual(clean.breadcrumbs.length, 1);
assert(Object.prototype.hasOwnProperty.call(eventInput, 'user'), 'event input was mutated');
assert(Object.prototype.hasOwnProperty.call(eventInput.request, 'data'), 'request input was mutated');
const serialized = JSON.stringify(clean);
for (const sensitiveValue of ['buyer@example.com', '01012345678', '1012345678', 'secret-token', 'PAY-123']) {
  assert(!serialized.includes(sensitiveValue), `sensitive value was retained: ${sensitiveValue}`);
}

assert.strictEqual(options.beforeSend({ message: '01012345678' }).message, '[REDACTED_PHONE]');
assert.strictEqual(options.beforeSend({ message: '+20 1012345678' }).message, '[REDACTED_PHONE]');
assert.strictEqual(options.beforeSend({ message: '0020 10 1234 5678' }).message, '[REDACTED_PHONE]');
assert.strictEqual(options.beforeSend({ message: '010-1234-5678' }).message, '[REDACTED_PHONE]');
const unrelatedNumbers = 'Order 1234567890 costs 20260.50 EGP; test port 38486';
assert.strictEqual(options.beforeSend({ message: unrelatedNumbers }).message, unrelatedNumbers);

const extensionEvent = {
  exception: { values: [{ stacktrace: { frames: [{ filename: 'chrome-extension://abc/script.js' }] } }] },
};
assert.strictEqual(options.beforeSend(extensionEvent), null, 'browser extension error was not filtered');

console.log('sentry-privacy-test: preview gating, basic monitoring, privacy scrubbing, and noise filtering passed');

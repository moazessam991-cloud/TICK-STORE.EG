#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const config = read('supabase/config.toml');
const push = read('supabase/functions/send-order-push/index.ts');
const order = read('supabase/functions/create-order/index.ts');
const migration = read(
  'supabase/migrations/20260810030000_order_push_notifications.sql'
);
const frontend = read('public/index.html');
const firebaseInit = read('public/firebase-init.js');
const firebaseWorker = read('public/firebase-messaging-sw.js');

// Public checkout must never talk to Firebase directly.
assert(
  !order.includes('FIREBASE_PRIVATE_KEY'),
  'public create-order reads the Firebase private key'
);
assert(
  !order.includes('FIREBASE_CLIENT_EMAIL'),
  'public create-order reads the Firebase service account'
);
assert(
  !order.includes('fcm.googleapis.com'),
  'public create-order sends directly to FCM'
);
assert(
  !order.includes('oauth2.googleapis.com'),
  'public create-order performs Firebase OAuth directly'
);

// Checkout may only queue the hardened internal push endpoint.
assert(
  order.includes('TICK_PUSH_NOTIFICATION_SECRET'),
  'checkout does not use the dedicated push secret'
);
assert(
  order.includes('/functions/v1/send-order-push'),
  'checkout does not call the hardened push function'
);
assert(
  order.includes('"x-tick-push-secret": pushSecret'),
  'checkout is missing internal push authentication'
);
assert(
  order.includes('body: JSON.stringify({ order_id: orderId })'),
  'checkout sends more than the trusted order identifier to push'
);
assert(
  order.includes('Deno.env.get("TICK_PUSH_ENABLED") !== "true"'),
  'checkout does not fail closed when push is disabled'
);
assert(
  order.includes('EdgeRuntime'),
  'push notification is not attached to the Edge background lifecycle'
);
assert(
  order.includes('runtime.waitUntil(task)'),
  'push notification is not queued in the background'
);
assert(
  order.includes('queueOrderPushNotification(String(publicOrder.id))'),
  'push notification is not based on the committed order id'
);
assert(
  order.includes('order_push_queue_failed'),
  'push queue failure is not isolated from checkout success'
);

// Function must be explicitly configured as an internal endpoint.
assert(
  config.includes('[functions.send-order-push]'),
  'send-order-push is missing from Supabase config'
);
assert(
  /(?:\[functions\.send-order-push\][\s\S]*?)verify_jwt\s*=\s*false/.test(config),
  'send-order-push must use its dedicated internal secret instead of Supabase JWT verification'
);

// Push must remain fail-closed until explicitly enabled.
assert(
  push.includes('Deno.env.get("TICK_PUSH_ENABLED") !== "true"'),
  'push sender is not fail-closed behind TICK_PUSH_ENABLED'
);
assert(
  push.includes('push_notifications_disabled'),
  'disabled push sender does not return the expected safe error'
);

// Internal endpoint must authenticate using a dedicated push secret.
assert(
  push.includes('TICK_PUSH_NOTIFICATION_SECRET'),
  'push sender does not require its dedicated internal secret'
);
assert(
  push.includes('x-tick-push-secret'),
  'push sender is missing the dedicated internal auth header'
);
assert(
  push.includes('safeSecretEqual'),
  'push secret is not compared through the hardened helper'
);
assert(
  push.includes('return jsonResponse(401'),
  'unauthorized push calls are not rejected'
);

// Caller may provide exactly one trusted identifier.
assert(
  push.includes('Object.keys(body).length !== 1'),
  'push request does not enforce a one-field contract'
);
assert(
  push.includes('body.order_id'),
  'push request does not require order_id'
);
assert(
  push.includes('UUID_PATTERN.test(body.order_id)'),
  'push order_id is not UUID validated'
);

// Caller must never control destination tokens or notification contents.
for (const forbidden of [
  'body.token',
  'body.tokens',
  'body.title',
  'body.message',
  'body.notification',
  'body.url',
  'body.device',
]) {
  assert(
    !push.includes(forbidden),
    `caller-controlled push field remains: ${forbidden}`
  );
}

// Firebase service-account credentials must remain server-side.
for (const secretName of [
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
]) {
  assert(
    push.includes(secretName),
    `${secretName} is not read server-side`
  );

  assert(
    !frontend.includes(secretName),
    `${secretName} leaked into public/index.html`
  );
  assert(
    !firebaseInit.includes(secretName),
    `${secretName} leaked into firebase-init.js`
  );
  assert(
    !firebaseWorker.includes(secretName),
    `${secretName} leaked into firebase-messaging-sw.js`
  );
}

// Firebase OAuth must use a signed service-account JWT and FCM HTTP v1.
assert(
  push.includes('"RS256"'),
  'Firebase service-account JWT is not signed with RS256'
);
assert(
  push.includes('crypto.subtle.sign'),
  'Firebase JWT signature is missing'
);
assert(
  push.includes('https://oauth2.googleapis.com/token'),
  'Firebase OAuth token endpoint is missing'
);
assert(
  push.includes('https://www.googleapis.com/auth/firebase.messaging'),
  'Firebase Messaging OAuth scope is missing'
);
assert(
  push.includes('fcm.googleapis.com/v1/projects/'),
  'FCM HTTP v1 endpoint is missing'
);

// Notification content and destinations must come from trusted DB state.
assert(
  push.includes('.from("orders")'),
  'push sender does not fetch the authoritative order'
);
assert(
  push.includes('.from("push_tokens")'),
  'push sender does not fetch registered tokens server-side'
);
assert(
  push.includes('order.total_amount'),
  'push content is not based on authoritative order data'
);

// Request surface must stay bounded.
assert(
  push.includes('MAX_BODY_BYTES = 1024'),
  'push request size limit is missing'
);
assert(
  push.includes('req.method !== "POST"'),
  'push endpoint is not POST-only'
);
assert(
  push.includes('request_body_too_large'),
  'oversized push requests are not rejected'
);
assert(
  push.includes('MAX_PUSH_DEVICES = 100'),
  'push device fan-out does not have a hard upper bound'
);

// Durable per-order/per-device dedupe must exist.
assert(
  push.includes('claim_order_push_delivery'),
  'push sender does not claim deliveries before sending'
);
assert(
  push.includes('finish_order_push_delivery'),
  'push sender does not record delivery completion'
);
assert(
  push.includes('p_attempt_count: attemptCount'),
  'push completion is not bound to the claimed attempt'
);

assert(
  /primary key\s*\(\s*order_id\s*,\s*push_token_id\s*\)/i.test(migration),
  'push dedupe is not keyed per order and device'
);
assert(
  /state\s+text\s+not null[\s\S]*?sending[\s\S]*?sent[\s\S]*?failed/i.test(migration),
  'push delivery state constraint is missing'
);
assert(
  /attempt_count\s+integer\s+not null/i.test(migration),
  'push delivery attempt counter is missing'
);

// Stale concurrent attempts must not overwrite a newer attempt.
assert(
  /and attempt_count = p_attempt_count/i.test(migration),
  'push completion is not concurrency-safe'
);
assert(
  /and state = 'sending'/i.test(migration),
  'push completion can overwrite a completed delivery'
);

// Invalid FCM tokens should only be removed when Firebase declares them dead.
assert(
  push.includes('detail.errorCode === "UNREGISTERED"'),
  'UNREGISTERED Firebase tokens are not detected'
);
assert(
  push.includes('.from("push_tokens")') &&
    push.includes('.delete()') &&
    push.includes('.eq("id", device.id)'),
  'invalid FCM tokens are not removed server-side'
);

// Push token/delivery data must not be readable or executable by public roles.
assert(
  /alter table public\.order_push_deliveries enable row level security/i.test(migration),
  'RLS is not enabled on order_push_deliveries'
);
assert(
  /revoke all[\s\S]*?order_push_deliveries[\s\S]*?from public, anon, authenticated/i.test(migration),
  'public roles retain privileges on order_push_deliveries'
);
assert(
  /revoke all[\s\S]*?claim_order_push_delivery\(uuid, uuid\)[\s\S]*?from public, anon, authenticated/i.test(migration),
  'public roles can execute claim_order_push_delivery'
);
assert(
  /revoke all[\s\S]*?finish_order_push_delivery[\s\S]*?from public, anon, authenticated/i.test(migration),
  'public roles can execute finish_order_push_delivery'
);
assert(
  /grant all[\s\S]*?order_push_deliveries[\s\S]*?to service_role/i.test(migration),
  'service_role does not own the push delivery workflow'
);

// Missing parent rows must fail safely instead of causing an FK race.
assert(
  migration.includes("'missing_order'"),
  'push claim does not explicitly handle a missing order'
);
assert(
  migration.includes("'missing_token'"),
  'push claim does not explicitly handle a missing push token'
);
assert(
  /from public\.orders[\s\S]*?for key share/i.test(migration),
  'order parent row is not protected during claim'
);
assert(
  /from public\.push_tokens[\s\S]*?for key share/i.test(migration),
  'push token parent row is not protected during claim'
);

console.log('✓ Push notification security static checks passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const config = read('supabase/config.toml');
const relay = read('supabase/functions/send-order-notification/index.ts');
const order = read('supabase/functions/create-order/index.ts');
const migration = read('supabase/migrations/20260810010000_order_email_notifications.sql');

// Public checkout must remain independent from notification providers.
assert(!order.includes('RESEND_API_KEY'), 'public create-order reads the email provider secret');
assert(!order.includes('ADMIN_EMAIL'), 'public create-order controls the email recipient');
assert(!order.includes('firebase.googleapis.com'), 'public create-order still sends push');
assert(!order.includes('TWILIO'), 'public create-order still sends WhatsApp');

assert(order.includes('TICK_NOTIFICATION_SECRET'), 'checkout does not authenticate to the notification function');
assert(order.includes('/functions/v1/send-order-notification'), 'checkout does not call the hardened notification function');
assert(order.includes('body: JSON.stringify({ order_id: orderId })'), 'checkout sends more than the trusted order identifier');
assert(order.includes('EdgeRuntime'), 'checkout notification is not attached to the Edge background lifecycle');
assert(order.includes('waitUntil'), 'checkout notification is not queued in the background');
assert(
  order.includes('queueOrderEmailNotification(String(publicOrder.id))'),
  'notification is not based on the committed public order id'
);
assert(
  order.includes('order_notification_queue_failed'),
  'notification queue failure is not isolated from checkout success'
);

// Notification function authenticates with its own dedicated internal secret.
assert(relay.includes('TICK_NOTIFICATION_SECRET'), 'notification function does not require the dedicated secret');
assert(relay.includes('x-tick-notification-secret'), 'notification function is missing the internal auth header');
assert(relay.includes('safeSecretEqual'), 'notification secret is not compared through the hardened helper');
assert(relay.includes('return jsonResponse(401'), 'unauthorized notification calls are not rejected');

// Caller may supply exactly one field: order_id.
assert(relay.includes('Object.keys(body).length !== 1'), 'notification body does not enforce a one-field contract');
assert(relay.includes('body.order_id'), 'notification function does not require order_id');
assert(relay.includes('UUID_PATTERN.test(body.order_id)'), 'order_id is not UUID validated');

// Never accept caller-controlled relay fields.
for (const forbidden of [
  'body.to',
  'body.recipient',
  'body.recipients',
  'body.subject',
  'body.html',
  'body.from',
]) {
  assert(!relay.includes(forbidden), `caller-controlled email field remains: ${forbidden}`);
}

// Destination and provider credentials are server-side only.
assert(relay.includes('RESEND_API_KEY'), 'email provider secret is not read server-side');
assert(relay.includes('ADMIN_EMAIL'), 'notification recipient is not server-controlled');
assert(relay.includes('to: [adminEmail]'), 'email destination is not fixed to ADMIN_EMAIL');

// Order content comes from the authoritative database.
assert(relay.includes('.from("orders")'), 'notification does not fetch the authoritative order');
assert(relay.includes('.from("order_items")'), 'notification does not fetch authoritative order items');
assert(relay.includes('products(name)'), 'notification does not fetch product names from the database');

// Browser-controlled text must be HTML escaped before rendering.
assert(relay.includes('function escapeHtml'), 'HTML escaping helper is missing');
assert(relay.includes('escapeHtml(order.customer_name'), 'customer name is not HTML escaped');
assert(relay.includes('escapeHtml(order.customer_phone'), 'customer phone is not HTML escaped');
assert(relay.includes('escapeHtml(order.notes'), 'order notes are not HTML escaped');

// Request size and method are bounded.
assert(relay.includes('MAX_BODY_BYTES = 1024'), 'notification request size limit is missing');
assert(relay.includes('req.method !== "POST"'), 'notification endpoint is not POST-only');
assert(relay.includes('request_body_too_large'), 'oversized notification requests are not rejected');

// Durable duplicate-send protection exists.
assert(relay.includes('claim_order_email_notification'), 'notification claim RPC is not used');
assert(relay.includes('finish_order_email_notification'), 'notification completion RPC is not used');
assert(relay.includes('p_attempt_count: attemptCount'), 'finish RPC is not bound to the claimed attempt');
assert(relay.includes('const attemptCount = Number(claim?.attempt_count)'), 'claim attempt number is not validated');
assert(relay.includes('claimState === "missing"'), 'missing orders are not handled explicitly');
assert(relay.includes('error: "order_not_found"'), 'missing orders do not map to order_not_found');
assert(relay.includes('Idempotency-Key'), 'provider idempotency key is missing');

assert(
  /create table if not exists public\.order_email_notifications/i.test(migration),
  'notification state table is missing',
);
assert(
  /primary key\s*[\r\n\s]*references public\.orders\(id\)/i.test(migration) ||
  /order_id uuid primary key[\s\S]*references public\.orders\(id\)/i.test(migration),
  'notification state is not one-row-per-order',
);
assert(
  /create or replace function public\.claim_order_email_notification/i.test(migration),
  'atomic claim RPC is missing',
);
assert(
  /create or replace function public\.finish_order_email_notification/i.test(migration),
  'finish RPC is missing',
);
assert(
  /revoke all on function public\.claim_order_email_notification\(uuid\)[\s\S]*from public, anon, authenticated/i.test(migration),
  'claim RPC is exposed to browser roles',
);
assert(
  /grant execute on function public\.claim_order_email_notification\(uuid\)[\s\S]*to service_role/i.test(migration),
  'claim RPC is not service-role only',
);
assert(
  /revoke all on function public\.finish_order_email_notification\(uuid, integer, boolean, text, text\)[\s\S]*from public, anon, authenticated/i.test(migration),
  'finish RPC is exposed to browser roles',
);
assert(
  /grant execute on function public\.finish_order_email_notification\(uuid, integer, boolean, text, text\)[\s\S]*to service_role/i.test(migration),
  'finish RPC is not service-role only',
);

// Until deployment configuration is deliberately added, the function may
// remain absent from config.toml. If present later, it must be explicitly named.
if (config.includes('[functions.send-order-notification]')) {
  assert(
    /\[functions\.send-order-notification\][\s\S]*enabled\s*=\s*true/i.test(config),
    'configured notification function is not explicitly enabled',
  );
}


const missingOrderGuard = read('supabase/migrations/20260810020000_order_email_missing_order_guard.sql');

assert(
  /from public\.orders[\s\S]*where id = p_order_id[\s\S]*for key share/i.test(missingOrderGuard),
  'missing-order guard does not lock/check the parent order'
);
assert(
  /'state', 'missing'/i.test(missingOrderGuard),
  'missing-order guard does not return the missing state'
);
assert(
  /revoke all on function public\.claim_order_email_notification\(uuid\)[\s\S]*from public, anon, authenticated/i.test(missingOrderGuard),
  'replacement claim RPC is exposed to browser roles'
);

console.log(
  'email-relay-security-test: authenticated database-backed order email notification controls passed'
);

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const edge = read('supabase/functions/create-order/index.ts');
const server = read('server/index.js');
const client = read('public/index.html');
const migration = read('supabase/migrations/20260808010000_preview_security_hardening.sql');
const verifier = read('supabase/verification/verify_preview_security_hardening.sql');
const authoritativeOrderMigration = read('supabase/migrations/20260724010000_instapay_payment_flow.sql');
const lifecycleMigrations = [
  authoritativeOrderMigration,
  read('supabase/migrations/20260724020000_order_cancellation_cron_hardening.sql'),
  read('supabase/migrations/20260725010000_instapay_proof_stops_expiry.sql'),
  read('supabase/migrations/20260725020000_confirmed_order_cancellation.sql'),
].join('\n');

assert(edge.includes('MAX_BODY_BYTES = 32 * 1024'));
assert(edge.includes('MAX_LINE_ITEMS = 20'));
assert(edge.includes('MAX_ITEM_QUANTITY = 10'));
assert(edge.includes('MAX_TOTAL_QUANTITY = 30'));
assert(edge.includes('hasOnlyKeys'), 'unknown request keys are not rejected');
assert(edge.includes('CHECKOUT_TOKEN_PATTERN'));
assert(edge.includes('UUID_PATTERN'));
assert(edge.includes('origin_not_allowed'));
assert(!edge.includes('"Access-Control-Allow-Origin": "*"'));
assert(edge.includes('consume_order_abuse_limits'));
assert(edge.includes('create_preview_order_with_stock'));
assert(edge.includes('order_rate_limited'));
assert(edge.includes('status: 429'));
assert(edge.includes('fingerprint(abuseSecret, "ip"'));
assert(edge.includes('fingerprint(abuseSecret, "phone"'));
assert(edge.includes('fingerprint(abuseSecret, "checkout"'));
assert(!edge.includes('item.price'), 'browser price must not be forwarded as trusted item data');
assert(edge.includes('const publicOrder = publicOrderResponse(order)'));
assert(edge.includes('{ ok: true, order: publicOrder }'));
assert(!edge.includes('{ ok: true, order }'), 'raw RPC order object is still returned publicly');

const publicFieldsMatch = edge.match(/const PUBLIC_ORDER_RESPONSE_FIELDS = \[([\s\S]*?)\] as const;/);
assert(publicFieldsMatch, 'public order response allowlist is missing');
const publicFields = [...publicFieldsMatch[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
assert.deepStrictEqual(publicFields, [
  'id',
  'total_amount',
  'payment_method',
  'payment_status',
  'payment_expires_at',
  'status',
  'created_at',
  'idempotent_replay',
]);
const sentinelOrder = {
  id: '00000000-0000-4000-8000-000000000001',
  total_amount: 100,
  payment_method: 'COD',
  payment_status: 'unpaid',
  payment_expires_at: null,
  status: 'pending',
  created_at: '2026-08-09T00:00:00Z',
  idempotent_replay: true,
  customer_phone: 'PRIVATE',
  customer_email: 'PRIVATE',
  shipping_address: { addr: 'PRIVATE' },
  payment_proof_path: 'PRIVATE',
  stock_restored_at: 'PRIVATE',
  future_private_column: 'PRIVATE',
};
const projectedSentinel = Object.fromEntries(publicFields.map((field) => [field, sentinelOrder[field]]));
for (const privateField of [
  'customer_phone', 'customer_email', 'shipping_address', 'payment_proof_path',
  'stock_restored_at', 'future_private_column',
]) assert(!Object.prototype.hasOwnProperty.call(projectedSentinel, privateField), `${privateField} leaked through public projection`);

assert(client.includes('pid:String(item.pid||\'\')'));
assert(client.includes('qty:Number(item.qty)'));
assert(!client.includes('price:Number(item.price)'));
assert(server.includes("return res.status(410).json({ error: 'legacy_order_route_disabled' })"));

assert(migration.includes('create table public.order_abuse_counters'));
assert(migration.includes("('ip'::text, p_ip_hash, interval '10 minutes', 5)"));
assert(migration.includes("('phone'::text, p_phone_hash, interval '30 minutes', 3)"));
assert(migration.includes("('checkout'::text, p_checkout_hash, interval '30 minutes', 3)"));
assert(migration.includes("updated_at < v_now - interval '24 hours'"));
assert(migration.includes('on conflict (scope, fingerprint, window_started)'));
assert(migration.includes('attempt_count = public.order_abuse_counters.attempt_count + 1'));
assert(migration.includes('returning attempt_count into v_attempt_count'));
assert(migration.includes("v_active_cod_count >= 2"));
assert(migration.includes("created_at >= clock_timestamp() - interval '24 hours'"));
assert(migration.includes('pg_advisory_xact_lock(hashtextextended(p_phone_hash, 0))'));
assert(migration.includes('return public.create_order_with_stock(p_order, p_items)'));

const wrapperStart = migration.indexOf('create or replace function public.create_preview_order_with_stock');
const wrapperEnd = migration.indexOf('create or replace function public.enforce_preview_payment_method');
assert(wrapperStart >= 0 && wrapperEnd > wrapperStart);
const wrapper = migration.slice(wrapperStart, wrapperEnd);
assert(!wrapper.includes('public.orders%rowtype'), 'wrapper still binds the complete private order row');
assert(!wrapper.includes('to_jsonb(v_existing'), 'replay still serializes an order row');
assert(wrapper.includes('select id\n    into v_existing_order_id'), 'replay control flow should select only the order id');
const checkoutLockIndex = wrapper.indexOf('pg_advisory_xact_lock(hashtextextended(v_checkout_token, 0))');
const existingCheckIndex = wrapper.indexOf('select id\n    into v_existing_order_id');
const replayDelegateIndex = wrapper.indexOf('if found then\n    return public.create_order_with_stock(p_order, p_items);');
const settingIndex = wrapper.indexOf('select value\n    into v_setting');
const phoneLockIndex = wrapper.indexOf('pg_advisory_xact_lock(hashtextextended(p_phone_hash, 0))');
const capIndex = wrapper.indexOf('v_active_cod_count >= 2');
const finalDelegateIndex = wrapper.lastIndexOf('return public.create_order_with_stock(p_order, p_items)');
assert(checkoutLockIndex < existingCheckIndex, 'checkout replay check is not serialized');
assert(existingCheckIndex < replayDelegateIndex, 'existing token is not delegated through the authoritative RPC');
assert(replayDelegateIndex < settingIndex, 'genuine retry can be blocked by a later setting change');
assert(replayDelegateIndex < phoneLockIndex, 'genuine retry can be blocked by its original COD reservation');
assert(phoneLockIndex < capIndex && capIndex < finalDelegateIndex, 'new COD orders do not serialize and cap before creation');

assert(authoritativeOrderMigration.includes('for update of product'), 'authoritative product locks were lost');
assert(authoritativeOrderMigration.includes("raise exception using message = 'order_total_changed'"), 'authoritative price check was lost');
assert(authoritativeOrderMigration.includes('set stock_quantity = coalesce(product.stock_quantity, 0) - requested.quantity'), 'authoritative stock deduction was lost');

const defaultRows = [...migration.matchAll(/\('(cod|instapay)',\s*'(true|false)'::jsonb\)/g)]
  .reduce((out, match) => ({ ...out, [match[1]]: match[2] === 'true' }), {});
assert.deepStrictEqual(defaultRows, { cod: true, instapay: false });
assert(wrapper.includes("if found and jsonb_typeof(v_setting) = 'boolean' then"));
assert(wrapper.includes('else\n    v_enabled := false;'), 'missing/malformed payment settings do not fail closed');
const paymentEnabled = (rowExists, storedValue, key) => {
  const afterMigration = rowExists ? storedValue : defaultRows[key];
  return typeof afterMigration === 'boolean' ? afterMigration : false;
};
assert.strictEqual(paymentEnabled(true, true, 'cod'), true);
assert.strictEqual(paymentEnabled(true, false, 'cod'), false);
assert.strictEqual(paymentEnabled(false, undefined, 'cod'), true);
assert.strictEqual(paymentEnabled(false, undefined, 'instapay'), false);
assert.strictEqual(paymentEnabled(true, 'true', 'cod'), false);
assert.strictEqual(paymentEnabled(true, { enabled: true }, 'instapay'), false);
assert(edge.includes('validated.payment === "InstaPay" && Deno.env.get("TICK_INSTAPAY_ENABLED") !== "true"'));
assert(server.includes('instapay: false'), 'Express and database missing-setting defaults disagree');
assert(server.includes("else if (row.key === 'cod' || row.key === 'instapay') settings[row.key] = false;"),
  'Express does not fail closed on malformed persisted payment settings');

const limiterStart = migration.indexOf('create or replace function public.consume_order_abuse_limits');
const limiterEnd = migration.indexOf('revoke all on function public.consume_order_abuse_limits');
const limiter = migration.slice(limiterStart, limiterEnd);
const denialIndex = limiter.indexOf('if v_attempt_count > v_rule.attempt_limit then');
const deniedReturnIndex = limiter.indexOf("'allowed', false", denialIndex);
const allowedReturnIndex = limiter.lastIndexOf("'allowed', true");
assert(denialIndex >= 0 && deniedReturnIndex > denialIndex && allowedReturnIndex > deniedReturnIndex,
  'an exceeded identifier can fall through to an allowed response');
assert(!/raise exception[\s\S]*order_rate_limited/i.test(limiter), 'denials would roll back their counter increments');
assert(migration.includes("fingerprint ~ '^[0-9a-f]{64}$'"), 'raw limiter identifiers are not structurally excluded');

const triggerStart = migration.indexOf('create or replace function public.enforce_preview_payment_method');
const triggerEnd = migration.indexOf('-- Settings are read through', triggerStart);
const triggerSection = migration.slice(triggerStart, triggerEnd);
assert(triggerSection.includes('before insert or update of payment_method on public.orders'));
assert(triggerSection.includes("new.payment_method not in ('COD', 'InstaPay')"));
assert(!/update\s+public\.orders/i.test(triggerSection), 'trigger installation mutates historical order rows');
const lifecycleOrderUpdates = lifecycleMigrations.replace(/\s+/g, ' ')
  .match(/update\s+(?:public\.)?orders\b[^;]*;/gi) || [];
for (const updateStatement of lifecycleOrderUpdates) {
  assert(!/(?:\bset|,)\s*payment_method\s*=/i.test(updateStatement),
    'an existing database lifecycle changes payment_method and may trip the preview trigger');
}

assert(migration.includes('legacy_is_admin_definition_requires_review'));
assert(migration.includes('legacy_handle_new_user_definition_requires_review'));
assert(migration.includes('legacy_helper_security_mode_requires_review'));
assert(migration.includes("strpos(v_body, 'auth.uid()')"));
assert(migration.includes("strpos(v_body, 'insertintopublic.profiles')"));
assert(migration.includes("set search_path = pg_catalog, public"));

for (const requiredPreflightEvidence of [
  'application_state',
  'post_apply_detected',
  'already_applied_or_partial_state',
  'abuse_table_compatible',
  'abuse_index_compatible',
  'scope_column_compatible',
  'fingerprint_column_compatible',
  'window_column_compatible',
  'attempt_column_compatible',
  'updated_column_compatible',
  'abuse_primary_key_columns',
  'scope_check_expression',
  'fingerprint_check_expression',
  'attempt_check_expression',
  'abuse_browser_table_access',
  'abuse_browser_column_access',
  'abuse_service_role_all_access',
  'abuse_index_key_column',
  'repository_compatible',
  'profile_policy',
  'profile_browser_grant',
  'profile_browser_column_grant',
  'rls_enabled',
  'force_rls',
  'legacy_helper_definition',
  'handle_new_user_trigger_dependency',
  'payment_setting',
  'historical_payment_method',
  'payment_method_update_workflow',
  'preview_payment_trigger_name',
  'protected_rpc_contract',
  'unexpected_protected_rpc_overload',
  'pg_get_functiondef',
  'security_definer',
  'search_path',
  'service_role_execute',
  'CANNOT_VERIFY',
  'BLOCKED',
]) assert(verifier.includes(requiredPreflightEvidence), `preflight omits ${requiredPreflightEvidence}`);

// Mirror the verifier's state-sensitive decision tables so every requested
// pre/post-application edge is explicit and guarded by source evidence.
const classifyMigrationObject = ({ postApply, present, compatible }) => {
  if (!present) return postApply ? 'BLOCKED' : 'PASS';
  if (!compatible) return 'BLOCKED';
  return postApply ? 'PASS' : 'WARNING';
};
assert.strictEqual(classifyMigrationObject({ postApply: false, present: false, compatible: false }), 'PASS');
assert.strictEqual(classifyMigrationObject({ postApply: true, present: true, compatible: true }), 'PASS');
assert.strictEqual(classifyMigrationObject({ postApply: false, present: true, compatible: true }), 'WARNING');
assert.strictEqual(classifyMigrationObject({ postApply: true, present: true, compatible: false }), 'BLOCKED');
assert.strictEqual(classifyMigrationObject({ postApply: false, present: true, compatible: false }), 'BLOCKED');
assert.strictEqual(classifyMigrationObject({ postApply: true, present: false, compatible: false }), 'BLOCKED');
for (const compatibilityField of ['abuse_table_compatible', 'abuse_index_compatible']) {
  assert(new RegExp(`when ${compatibilityField} is not true then 'BLOCKED'[\\s\\S]{0,100}when post_apply_detected then 'PASS'`)
    .test(verifier), `${compatibilityField} does not preserve incompatible blocking and post-apply PASS`);
}

for (const rpcName of [
  'consume_order_abuse_limits',
  'create_preview_order_with_stock',
  'enforce_preview_payment_method',
]) {
  assert(verifier.includes(`when name = '${rpcName}' then`), `${rpcName} lacks a structural contract`);
}
assert(/when repository_compatible is not true then 'BLOCKED'[\s\S]{0,100}when app\.post_apply_detected then 'PASS'/
  .test(verifier), 'compatible protected RPCs do not become PASS after application');
assert(/when repository_compatible is not true then 'BLOCKED'[\s\S]{0,100}when app\.post_apply_detected then 'PASS'/
  .test(verifier.slice(verifier.indexOf('preview_payment_trigger_checks'))),
  'compatible payment trigger does not become PASS after application');
assert(/profiles_force_rls[\s\S]{0,180}profiles_policy_count = 0[\s\S]{0,180}then 'PASS'/
  .test(verifier), 'hardened profiles force-RLS state does not become PASS');

const historicalPaymentStatus = (paymentMethod) => ['COD', 'InstaPay'].includes(paymentMethod) ? 'PASS' : 'WARNING';
assert.strictEqual(historicalPaymentStatus('Cash on Delivery'), 'WARNING');
assert(/payment_method in \('COD', 'InstaPay'\)[\s\S]{0,60}then 'PASS' else 'WARNING'/
  .test(verifier), 'historical Cash on Delivery warning is no longer visible');
const summarizeStatuses = (statuses) => statuses.includes('BLOCKED') ? 'BLOCKED'
  : statuses.includes('CANNOT_VERIFY') ? 'CANNOT_VERIFY'
    : statuses.includes('WARNING') ? 'WARNING' : 'PASS';
const matchingPostApplyStatuses = [
  classifyMigrationObject({ postApply: true, present: true, compatible: true }),
  classifyMigrationObject({ postApply: true, present: true, compatible: true }),
  'PASS', 'PASS', 'PASS', 'PASS', historicalPaymentStatus('Cash on Delivery'),
];
assert.strictEqual(summarizeStatuses(matchingPostApplyStatuses), 'WARNING');
assert.notStrictEqual(summarizeStatuses(matchingPostApplyStatuses), 'BLOCKED',
  'expected installed migration objects incorrectly block the final summary');

const executableVerifier = verifier.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
assert(/^\s*with\b/i.test(executableVerifier), 'preflight verifier does not start with WITH');
assert(!/^\s*(?:insert|update|delete|create|alter|drop|truncate|grant|revoke|execute|do|call)\b/im.test(executableVerifier),
  'preflight verifier is not SELECT-only');

for (const name of ['consume_order_abuse_limits', 'create_preview_order_with_stock']) {
  assert(new RegExp(`revoke all on function public\\.${name}[\\s\\S]{0,180}from public, anon, authenticated`, 'i').test(migration));
  assert(new RegExp(`grant execute on function public\\.${name}[\\s\\S]{0,180}to service_role`, 'i').test(migration));
}

console.log('order-abuse-security-test: replay privacy, settings, limiter, COD ordering, trigger, and preflight contracts passed');

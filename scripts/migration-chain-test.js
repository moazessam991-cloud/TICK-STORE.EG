#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const migrationDir = path.join(root, 'supabase', 'migrations');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sha256(relativePath) {
  return crypto.createHash('sha256').update(read(relativePath)).digest('hex');
}

function tableBlock(sql, tableName) {
  const expression = new RegExp(
    `create\\s+table\\s+public\\.${tableName}\\s*\\(([\\s\\S]*?)\\n\\);`,
    'i'
  );
  const match = sql.match(expression);
  assert(match, `missing baseline CREATE TABLE public.${tableName}`);
  return match[1];
}

function hasColumn(block, columnName) {
  return new RegExp(`^\\s*${columnName}\\s+`, 'mi').test(block);
}

const expectedHistorical = [
  '20260721010000_order_integrity.sql',
  '20260724010000_instapay_payment_flow.sql',
  '20260724020000_order_cancellation_cron_hardening.sql',
  '20260725010000_instapay_proof_stops_expiry.sql',
  '20260725020000_confirmed_order_cancellation.sql',
];

const expectedForward = [
  '20260801010000_schema_convergence.sql',
  '20260801020000_constraints_and_indexes.sql',
  '20260801030000_storage_buckets.sql',
  '20260802010000_product_images_storage_hardening.sql',
  '20260808010000_preview_security_hardening.sql',
];

const historicalHashes = {
  '20260724010000_instapay_payment_flow.sql':
    'd255c612c98c8c59e65922f69de3be9cb836235d87dd98ba077aa0f3f84cf2ab',
  '20260724020000_order_cancellation_cron_hardening.sql':
    'bc4765ea0b2b182bb1d317be3972f1f4cfddd1e18f157877e28d6d6329266011',
  '20260725010000_instapay_proof_stops_expiry.sql':
    'e9c73a4adc8f33b2c896d720968014107de2e457be0c7b1e4589b25426d82412',
  '20260725020000_confirmed_order_cancellation.sql':
    'f37f668634005b6912f19e5247cb9a2586acba1d3315d538c38116e1fd162faa',
};

const activeTables = [
  'categories',
  'products',
  'product_images',
  'orders',
  'order_items',
  'settings',
  'subscribers',
  'notify_me',
  'episodes',
  'push_tokens',
];

const excludedTables = [
  'profiles',
  'carts',
  'cart_items',
  'wishlist',
  'reviews',
  'coupons',
  'banners',
  'straps',
  'audit_log',
  'customers',
  'archive',
  'payment_events',
  'webhook_events',
];

const requiredColumns = {
  categories: ['id', 'name', 'slug', 'description', 'image_url', 'created_at'],
  products: [
    'id', 'category_id', 'brand', 'name', 'price', 'sale_price', 'emoji',
    'bg_color', 'tags', 'description_en', 'description_ar', 'size', 'movement',
    'case_size', 'crystal',
    'water_resistance', 'strap_type', 'power_reserve', 'stock_quantity',
    'video_url', 'model_3d_url', 'is_active', 'variants', 'era',
    'condition_rating', 'orig_price_reference', 'authentication_notes',
    'created_at', 'updated_at',
  ],
  product_images: ['id', 'product_id', 'url', 'position', 'storage_path', 'created_at'],
  orders: [
    'id', 'status', 'total_amount', 'payment_method', 'payment_status', 'payment_id',
    'customer_name', 'customer_phone', 'customer_email', 'shipping_address',
    'notes', 'created_at', 'updated_at',
  ],
  order_items: [
    'id', 'order_id', 'product_id', 'quantity', 'price_at_purchase', 'metadata',
    'created_at',
  ],
  settings: ['key', 'value', 'updated_at'],
  subscribers: ['id', 'email', 'source', 'subscribed_at'],
  notify_me: ['id', 'product_id', 'email', 'phone', 'contact_raw', 'created_at'],
  episodes: [
    'id', 'episode_number', 'title_en', 'title_ar', 'description_en',
    'description_ar', 'category', 'duration', 'video_url', 'created_at',
  ],
  push_tokens: ['id', 'token', 'device_name', 'platform', 'last_seen', 'created_at'],
};

const filenames = fs
  .readdirSync(migrationDir)
  .filter((name) => /^\d{14}_.+\.sql$/.test(name))
  .sort();

for (const filename of [...expectedHistorical, ...expectedForward]) {
  assert(filenames.includes(filename), `missing or renamed migration ${filename}`);
}

assert.deepStrictEqual(
  filenames.filter((name) => expectedHistorical.includes(name)),
  expectedHistorical,
  'historical business migration order changed'
);

for (const filename of expectedForward) {
  assert(
    Number(filename.slice(0, 14)) > 20260725020000,
    `${filename} must sort after the last recorded historical version`
  );
}

for (const [filename, expectedHash] of Object.entries(historicalHashes)) {
  assert.strictEqual(
    sha256(path.join('supabase', 'migrations', filename)),
    expectedHash,
    `${filename} changed; recorded migrations 2-5 must remain byte-for-byte intact`
  );
}

const baselinePath = 'supabase/migrations/20260721010000_order_integrity.sql';
const baseline = read(baselinePath);
const baselineLower = baseline.toLowerCase();
const historicalFirstMigration = childProcess.execFileSync(
  'git',
  ['show', `HEAD:${baselinePath}`],
  { cwd: root, encoding: 'utf8' }
);
const firstProductAlter = baselineLower.indexOf('alter table public.products');
const firstFunction = baselineLower.indexOf('create or replace function public.create_order_with_stock');

assert(firstProductAlter > 0, 'first products ALTER is missing');
assert(firstFunction > firstProductAlter, 'order RPC must remain after the order-integrity ALTERs');
assert(
  baseline.endsWith(historicalFirstMigration),
  'the existing order-integrity SQL must remain an unchanged suffix after the prepended baseline'
);
assert(baselineLower.includes('create extension if not exists pgcrypto'));
assert(!baselineLower.includes('uuid-ossp'), 'fresh baseline must not require uuid-ossp');

for (const tableName of activeTables) {
  const createAt = baselineLower.indexOf(`create table public.${tableName} (`);
  assert(createAt >= 0, `baseline does not create public.${tableName}`);
  assert(createAt < firstProductAlter, `public.${tableName} is created after the first ALTER`);
  assert(createAt < firstFunction, `public.${tableName} is created after a dependent function`);

  const block = tableBlock(baseline, tableName);
  for (const columnName of requiredColumns[tableName]) {
    assert(hasColumn(block, columnName), `public.${tableName}.${columnName} is missing from baseline`);
  }
}

for (const tableName of excludedTables) {
  assert(
    !new RegExp(`create\\s+table\\s+public\\.${tableName}\\b`, 'i').test(baseline),
    `legacy table public.${tableName} must not be in the active baseline`
  );
}

const productBlock = tableBlock(baseline, 'products');
const imageBlock = tableBlock(baseline, 'product_images');
const orderBlock = tableBlock(baseline, 'orders');

assert(/^\s*condition_rating\s+smallint\s*,?\s*$/mi.test(productBlock));
assert(!/^\s*condition_rating\s+integer\b/mi.test(productBlock));
assert(/condition_rating is null or condition_rating between 1 and 5/i.test(productBlock));
assert(!hasColumn(productBlock, 'force_out_of_stock'), 'existing first ALTER must add force_out_of_stock');
assert(baselineLower.indexOf('add column if not exists force_out_of_stock') > firstProductAlter);
assert(!hasColumn(orderBlock, 'checkout_token'), 'existing first ALTER must add checkout_token');
assert(baselineLower.includes('add column if not exists checkout_token text'));
assert(!hasColumn(imageBlock, 'display_order'), 'display_order is not canonical on fresh installs');
assert(hasColumn(imageBlock, 'position'));
assert(hasColumn(imageBlock, 'storage_path'));
assert(!hasColumn(tableBlock(baseline, 'episodes'), 'video'));
assert(!hasColumn(tableBlock(baseline, 'episodes'), 'views'));

const allMigrations = filenames
  .map((filename) => read(path.join('supabase', 'migrations', filename)))
  .join('\n');

for (const laterColumn of [
  'checkout_token',
  'payment_reference',
  'payment_sender_name',
  'payment_proof_path',
  'payment_expires_at',
  'payment_submitted_at',
  'payment_verified_at',
  'payment_verified_by',
  'payment_rejected_at',
  'payment_rejection_reason',
  'stock_restored_at',
]) {
  assert(
    new RegExp(`add column if not exists ${laterColumn}\\b`, 'i').test(allMigrations),
    `later migrations do not add public.orders.${laterColumn}`
  );
}

for (const protectedRpc of [
  'create_order_with_stock',
  'adjust_product_stock',
  'get_instapay_order_for_customer',
  'submit_instapay_payment_proof',
  'confirm_instapay_payment',
  'reject_instapay_payment',
  'expire_instapay_orders',
  'cancel_order_with_stock',
  'update_order_fulfillment_status',
  'confirm_card_payment',
]) {
  const unsafeGrant = new RegExp(
    `grant\\s+execute\\s+on\\s+function\\s+public\\.${protectedRpc}\\s*\\([^;]*?\\)\\s+to\\s+(public|anon|authenticated)`,
    'i'
  );
  assert(!unsafeGrant.test(allMigrations), `${protectedRpc} received an unsafe direct grant`);
}

assert(!/create\s+policy[^;]*profiles[^;]*for\s+select[^;]*using\s*\(\s*true\s*\)/i.test(allMigrations));
assert(!/grant\s+select\s+on\s+table\s+public\.subscribers/i.test(baseline));
assert(!/create\s+policy\s+\w*subscribers\w*[^;]*for\s+select/i.test(baseline));
assert(/grant\s+insert\s*\(\s*email\s*,\s*source\s*\)[^;]*public\.subscribers/i.test(baseline));

const convergence = read('supabase/migrations/20260801010000_schema_convergence.sql');
for (const coreTable of activeTables.filter((name) => !['subscribers', 'push_tokens'].includes(name))) {
  assert(
    !new RegExp(`create\\s+table\\s+(if\\s+not\\s+exists\\s+)?public\\.${coreTable}\\b`, 'i').test(convergence),
    `forward convergence must assert, not recreate, public.${coreTable}`
  );
}
assert(/add column if not exists variants jsonb/i.test(convergence));
assert(/add column if not exists position integer/i.test(convergence));
assert(/add column if not exists condition_rating smallint/i.test(convergence));
assert(!/add column if not exists condition_rating integer/i.test(convergence));
assert(/\('products', 'condition_rating', 'int2'\)/i.test(convergence));
assert(!/\('products', 'condition_rating', 'int4'\)/i.test(convergence));
assert(/column_name = 'display_order'/i.test(convergence));
assert(!/drop\s+column\s+(if\s+exists\s+)?display_order/i.test(convergence));
assert(!/create or replace function\s+public\.(create_order_with_stock|cancel_order_with_stock|confirm_instapay_payment)/i.test(convergence));

const constraints = read('supabase/migrations/20260801020000_constraints_and_indexes.sql');
assert(/not valid/i.test(constraints));
assert(/subscribers_email_lower_key/i.test(constraints));
assert(/product_images_product_position_idx/i.test(constraints));
assert(/condition_rating is null or condition_rating between 1 and 5/i.test(constraints));

const storage = read('supabase/migrations/20260801030000_storage_buckets.sql');
assert(storage.includes("'instapay-proofs'"));
assert(storage.includes("'product-images'"));
assert(storage.includes('5242880'));
for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
  assert(storage.includes(`'${mime}'`), `storage migration is missing ${mime}`);
}
assert(/'instapay-proofs'[\s\S]*?false[\s\S]*?5242880/i.test(storage));
assert(/'product-images'[\s\S]*?true[\s\S]*?5242880/i.test(storage));
assert(!/create\s+policy/i.test(storage), 'Phase 1 Storage migration must not add object mutation policies');

const previewSecurity = read('supabase/migrations/20260808010000_preview_security_hardening.sql');
assert(/create table public\.order_abuse_counters/i.test(previewSecurity));
assert(/create or replace function public\.consume_order_abuse_limits/i.test(previewSecurity));
assert(/create or replace function public\.create_preview_order_with_stock/i.test(previewSecurity));
assert(/revoke all on table public\.profiles from public, anon, authenticated/i.test(previewSecurity));
assert(/revoke all on table public\.settings from public, anon, authenticated/i.test(previewSecurity));
assert(/grant execute on function public\.create_preview_order_with_stock[\s\S]*?to service_role/i.test(previewSecurity));

const verification = read('supabase/verification/verify_phase1_schema_contract.sql');
assert(!/\b(insert|update|delete|alter|create|drop|grant|revoke)\s+(into|table|policy|function|on|from)\b/i.test(verification));
assert(/\('products', 'condition_rating', 'int2'\)/i.test(verification));
assert(!/\('products', 'condition_rating', 'int4'\)/i.test(verification));
assert(verification.includes('service_role_only_rpcs'));
assert(verification.includes('storage_bucket_contracts'));
assert(verification.includes('single_instapay_expiry_cron'));

for (const filename of filenames) {
  const sql = read(path.join('supabase', 'migrations', filename));
  const delimiterCounts = new Map();
  for (const delimiter of sql.match(/\$[a-z_]*\$/gi) || []) {
    delimiterCounts.set(delimiter, (delimiterCounts.get(delimiter) || 0) + 1);
  }
  for (const [delimiter, count] of delimiterCounts) {
    assert.strictEqual(count % 2, 0, `${filename} has an unbalanced ${delimiter} delimiter`);
  }
}

console.log(`migration-chain-test: ${activeTables.length} active tables and ${filenames.length} ordered migrations verified`);

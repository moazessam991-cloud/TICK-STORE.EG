const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const verifierPath = path.join(
  root,
  'supabase/verification/final_phase1_live_preflight.sql'
);
const verifier = fs.readFileSync(verifierPath, 'utf8');

const expectedCheckNames = [
  'categories_slug_not_blank',
  'products_price_nonnegative',
  'products_sale_price_valid',
  'products_stock_nonnegative',
  'products_condition_rating_range',
  'products_original_price_nonnegative',
  'products_variants_shape',
  'product_images_position_nonnegative',
  'orders_total_nonnegative',
  'orders_status_check',
  'order_items_quantity_positive',
  'order_items_price_nonnegative',
  'subscribers_email_not_blank',
  'notify_me_contact_present',
  'push_tokens_token_not_blank',
];

const expectedIndexNames = [
  'categories_slug_key',
  'subscribers_email_lower_key',
  'push_tokens_token_key',
  'products_active_category_idx',
  'product_images_product_position_idx',
  'order_items_order_id_idx',
  'order_items_product_id_idx',
  'orders_created_at_idx',
  'subscribers_subscribed_at_idx',
  'notify_me_created_at_idx',
  'episodes_episode_number_idx',
];

function normalizeCatalogExpression(value) {
  return value
    .replace(/[\s]+not[\s]+valid[\s]*$/i, '')
    .toLowerCase()
    .replaceAll('"', '')
    .replace(/\b(?:public|pg_catalog)\./g, '')
    .replace(/::(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*(?:\[\])?/g, '')
    .replace(/[\s()]/g, '');
}

function normalizeIndexPart(value) {
  return value
    .toLowerCase()
    .replaceAll('"', '')
    .replace(/\b(?:public|pg_catalog)\./g, '')
    .replace(/::(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*(?:\[\])?/g, '')
    .replace(/\s/g, '');
}

function indexesAreCompatible(expected, actual) {
  return actual.table === expected.table
    && actual.accessMethod === expected.accessMethod
    && actual.unique === expected.unique
    && actual.valid
    && actual.ready
    && actual.keys.map(normalizeIndexPart).join(',')
      === expected.keys.map(normalizeIndexPart).join(',')
    && actual.descending.join(',') === expected.descending.join(',')
    && actual.nullsFirst.join(',') === expected.nullsFirst.join(',')
    && normalizeCatalogExpression(actual.predicate)
      === normalizeCatalogExpression(expected.predicate);
}

function hasOr(expression) {
  return /(^|[^a-z])or([^a-z]|$)/i.test(expression);
}

function policyClauseState(expression, bucketId) {
  const value = (expression ?? 'true').toLowerCase();
  const quotedBucket = bucketId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bucketEquality = new RegExp(`bucket_id\\s*=\\s*'${quotedBucket}'`, 'i');
  const anyBucketEquality = /bucket_id\s*=\s*'[^']+'/i;
  const targetExclusion = value.includes(`bucket_id is distinct from '${bucketId}'`);

  if (/(^|[^a-z])false([^a-z]|$)/i.test(value)) return 'DENY';
  if (targetExclusion && !hasOr(value)) return 'DENY';
  if (bucketEquality.test(value)) return 'ALLOW';
  if (anyBucketEquality.test(value) && !hasOr(value)) return 'DENY';
  if (!/bucket_id/i.test(value)) return 'ALLOW';
  if (/bucket_id\s+is\s+distinct\s+from/i.test(value)
      && !anyBucketEquality.test(value)
      && !hasOr(value)) {
    return 'ALLOW';
  }
  return 'UNKNOWN';
}

function roleApplies(roles) {
  return roles.includes('public') || roles.includes('anon');
}

function actionState(policy, action, bucketId) {
  if (!roleApplies(policy.roles)) return null;
  if (policy.command !== 'ALL' && policy.command !== action) return null;

  const usingState = policyClauseState(policy.using ?? 'true', bucketId);
  const fallbackCheck = policy.command === 'UPDATE' || policy.command === 'ALL'
    ? policy.using
    : null;
  const checkState = policyClauseState(policy.withCheck ?? fallbackCheck ?? 'true', bucketId);

  if (action === 'INSERT') return checkState;
  if (action === 'DELETE') return usingState;
  if (usingState === 'DENY' || checkState === 'DENY') return 'DENY';
  if (usingState === 'ALLOW' && checkState === 'ALLOW') return 'ALLOW';
  return 'UNKNOWN';
}

function anonymousMutationAccess({
  action,
  bucketId,
  policies,
  tablePrivilege = true,
  columnPrivilege = false,
  rlsEnabled = true,
}) {
  if (!tablePrivilege && !columnPrivilege) return false;
  if (!rlsEnabled) return true;

  const evaluated = policies
    .map((policy) => ({ policy, state: actionState(policy, action, bucketId) }))
    .filter(({ state }) => state !== null);

  if (evaluated.some(({ policy, state }) => !policy.permissive && state === 'DENY')) {
    return false;
  }
  if (evaluated.some(({ state }) => state === 'UNKNOWN')) return null;
  return evaluated.some(({ policy, state }) => policy.permissive && state === 'ALLOW');
}

const conditionExpected = 'checkcondition_ratingisnullorcondition_rating>=1andcondition_rating<=5';
assert.equal(
  normalizeCatalogExpression(
    'CHECK ((("condition_rating" IS NULL) OR (("condition_rating" >= (1)::smallint) '
      + 'AND ("condition_rating" <= (5)::smallint))) NOT VALID'
  ),
  conditionExpected,
  'smallint casts, quotes, parentheses, and NOT VALID must not create a conflict'
);
assert.equal(
  normalizeCatalogExpression(
    "CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text]))) NOT VALID"
  ),
  "checkstatus=anyarray['pending','confirmed']",
  'ANY/ARRAY text casts must normalize without consuming surrounding SQL keywords'
);

const expectedDescendingIndex = {
  table: 'orders',
  accessMethod: 'btree',
  unique: false,
  keys: ['created_at'],
  descending: [true],
  nullsFirst: [true],
  predicate: '',
};
assert.equal(indexesAreCompatible(expectedDescendingIndex, {
  ...expectedDescendingIndex,
  keys: ['"public"."created_at"'],
  fullDefinition: 'CREATE INDEX any_name ON public.orders USING btree (created_at DESC)',
  valid: true,
  ready: true,
}), true, 'full-definition formatting must not affect a structural index match');
assert.equal(indexesAreCompatible(expectedDescendingIndex, {
  ...expectedDescendingIndex,
  table: 'order_items',
  valid: true,
  ready: true,
}), false, 'a different index target table must conflict');
assert.equal(indexesAreCompatible({
  ...expectedDescendingIndex,
  predicate: 'is_active is true',
}, {
  ...expectedDescendingIndex,
  predicate: 'is_active is false',
  valid: true,
  ready: true,
}), false, 'a genuinely different predicate must conflict');

const publicRead = {
  command: 'SELECT',
  roles: ['public'],
  permissive: true,
  using: "bucket_id = 'product-images'",
};
const serviceInsert = {
  command: 'INSERT',
  roles: ['service_role'],
  permissive: true,
  withCheck: "bucket_id = 'product-images'",
};
const otherBucketInsert = {
  command: 'INSERT',
  roles: ['anon'],
  permissive: true,
  withCheck: "bucket_id = 'instapay-proofs'",
};
const hardenedBroadInsert = {
  command: 'INSERT',
  roles: ['public'],
  permissive: true,
  withCheck: "owner_id is not null AND bucket_id is distinct from 'product-images'",
};

for (const policy of [publicRead, serviceInsert, otherBucketInsert, hardenedBroadInsert]) {
  assert.equal(anonymousMutationAccess({
    action: 'INSERT',
    bucketId: 'product-images',
    policies: [policy],
  }), false, `${policy.command}/${policy.roles.join(',')} must not authorize product-image upload`);
}

const clauseSpecificPolicy = {
  command: 'ALL',
  roles: ['anon'],
  permissive: true,
  using: "bucket_id = 'product-images'",
  withCheck: "bucket_id = 'instapay-proofs'",
};
assert.equal(anonymousMutationAccess({
  action: 'INSERT', bucketId: 'product-images', policies: [clauseSpecificPolicy],
}), false, 'INSERT must use WITH CHECK');
assert.equal(anonymousMutationAccess({
  action: 'DELETE', bucketId: 'product-images', policies: [clauseSpecificPolicy],
}), true, 'DELETE must use USING');
assert.equal(anonymousMutationAccess({
  action: 'UPDATE', bucketId: 'product-images', policies: [clauseSpecificPolicy],
}), false, 'UPDATE must require both USING and WITH CHECK');
assert.equal(anonymousMutationAccess({
  action: 'INSERT',
  bucketId: 'product-images',
  policies: [{
    command: 'INSERT',
    roles: ['anon'],
    permissive: true,
    withCheck: "bucket_id = 'product-images'",
  }],
}), true, 'a genuine anon target-bucket mutation policy must remain blocked by the verifier');
assert.equal(anonymousMutationAccess({
  action: 'INSERT',
  bucketId: 'product-images',
  policies: [{
    command: 'INSERT',
    roles: ['anon'],
    permissive: true,
    withCheck: "bucket_id is distinct from 'product-images' OR owner_id is null",
  }],
}), null, 'ambiguous OR logic must remain CANNOT_VERIFY instead of becoming a false PASS');

for (const objectName of [...expectedCheckNames, ...expectedIndexNames]) {
  assert.ok(verifier.includes(`'${objectName}'`), `verifier must include ${objectName}`);
}
assert.equal(new Set(expectedCheckNames).size, 15, 'the expected CHECK contract must contain 15 names');
assert.equal(new Set(expectedIndexNames).size, 11, 'the expected index contract must contain 11 names');

assert.match(verifier, /not\[\[:space:\]\]\+valid/, 'SQL must strip the NOT VALID suffix');
assert.doesNotMatch(verifier, /::\[a-z_ \]\+/, 'SQL must not use the greedy cast regex');
assert.doesNotMatch(verifier, /created_atdesc|subscribed_atdesc/, 'sort order must not be embedded in key text');
assert.ok((verifier.match(/indoption\[position_number - 1\]/g) || []).length >= 4,
  'detail and summary must read structural DESC/NULLS flags from pg_index.indoption');
assert.ok((verifier.match(/actual\.normalized_definition = any/g) || []).length >= 2,
  'detail and summary must use normalized CHECK semantics');
assert.ok((verifier.match(/case clause\.action_code/g) || []).length >= 2,
  'detail and summary must evaluate action-specific policy clauses');
assert.ok((verifier.match(/anonymous_access_possible/g) || []).length >= 4,
  'the final summary must consume the effective semantic access result');
assert.match(verifier, /when 'a' then clause\.with_check_state/,
  'INSERT must use WITH CHECK in SQL');
assert.match(verifier, /when 'd' then clause\.using_state/,
  'DELETE must use USING in SQL');
assert.match(verifier, /when 'w' then case/,
  'UPDATE must evaluate both USING and WITH CHECK in SQL');
assert.match(verifier, /storage_objects_acl/,
  'SQL must expose storage.objects table and column ACL metadata');
assert.ok((verifier.match(/anon_bypasses_rls/g) || []).length >= 8,
  'detail and summary must account for the anon role bypassing RLS');
assert.match(verifier, /historical_not_valid_constraints/,
  'SQL must expose exact unvalidated constraint names as warnings');

console.log('Phase 1 verifier source checks passed.');

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const instapayMigration = read('supabase/migrations/20260724010000_instapay_payment_flow.sql');
const cancellationMigration = read('supabase/migrations/20260724020000_order_cancellation_cron_hardening.sql');
const proofReviewMigration = read('supabase/migrations/20260725010000_instapay_proof_stops_expiry.sql');
const migration = `${instapayMigration}\n${cancellationMigration}\n${proofReviewMigration}`;
const server = read('server/index.js');
const client = read('public/supabase-client.js');
const html = read('public/index.html');
const edge = read('supabase/functions/create-order/index.ts');
const paymob = read('supabase/functions/paymob-webhook/index.ts');
const cronVerification = read('supabase/verification/verify_instapay_expiry.sql');
const proofReviewVerification = read('supabase/verification/test_instapay_proof_review_window.sql');
const sampleEnv = read('config.sample.env');
const checkout = html.slice(html.indexOf("} else if(S.ckStep===3){"), html.indexOf('function subDel(){'));
const instapayRendererSource = html.slice(
  html.indexOf('function instapayPaymentHTML(){'),
  html.indexOf('\nfunction copyInstapayText(', html.indexOf('function instapayPaymentHTML(){'))
);

const results = [];
function migrationFunction(source, name) {
  const start = source.indexOf(`create or replace function public.${name}`);
  assert(start >= 0, `missing ${name}`);
  const remainder = source.slice(start);
  const next = remainder.indexOf('\ncreate or replace function public.', 1);
  return next >= 0 ? remainder.slice(0, next) : remainder;
}
const expiryFunction = migrationFunction(proofReviewMigration, '_expire_instapay_order_locked');
const submitProofFunction = migrationFunction(proofReviewMigration, 'submit_instapay_payment_proof');
const confirmPaymentFunction = migrationFunction(proofReviewMigration, 'confirm_instapay_payment');
const rejectPaymentFunction = migrationFunction(proofReviewMigration, 'reject_instapay_payment');
const expirySweepFunction = migrationFunction(proofReviewMigration, 'expire_instapay_orders');
let uiFixtureOrder = {};
const uiFixtureState = {
  instapay: {
    id: '11111111-1111-4111-8111-111111111111',
    payment: {
      recipient_name: 'Moaz',
      payment_url: 'https://ipn.example/payment',
      qr_url: '',
    },
  },
  instapaySubmitting: false,
};
const renderInstapayFixture = new Function(
  'instapayOrder',
  'S',
  'finiteAmount',
  'escHTML',
  `return (${instapayRendererSource}\n);`
)(
  () => uiFixtureOrder,
  uiFixtureState,
  (value) => Number.isFinite(Number(value)) ? Number(value) : 0,
  (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
);
function renderInstapayStatus(status, overrides = {}) {
  uiFixtureOrder = {
    id: uiFixtureState.instapay.id,
    total_amount: 100,
    payment_status: status,
    payment_expires_at: status === 'pending_payment' ? new Date(Date.now() + 300000).toISOString() : null,
    payment_reference: '',
    ...overrides,
  };
  return renderInstapayFixture();
}
function check(name, fn) {
  fn();
  results.push(name);
}

check('COD remains unpaid and has no five-minute expiry', () => {
  assert(migration.includes("case when v_payment_method = 'InstaPay' then 'pending_payment' else 'unpaid' end"));
  assert(migration.includes("case when v_payment_method = 'InstaPay' then clock_timestamp() + interval '5 minutes' else null end"));
});
check('InstaPay expiry is database-generated at five minutes', () => {
  assert(migration.includes("clock_timestamp() + interval '5 minutes'"));
});
check('client-modified totals are rejected', () => {
  assert(migration.includes("message = 'order_total_changed'"));
});
check('client product prices are not used by PostgreSQL', () => {
  assert(!migration.includes("item ->> 'price'"));
  assert(migration.includes('product.sale_price < product.price'));
});
check('quantities are integer-limited', () => {
  assert(migration.includes("(item ->> 'qty')::integer > 100000"));
});
check('inactive, forced-out and insufficient stock are rejected', () => {
  assert(migration.includes('product.is_active is not true'));
  assert(migration.includes('product.force_out_of_stock is true'));
  assert(migration.includes("message = 'insufficient_stock'"));
});
check('checkout retries serialize and return the original order', () => {
  assert(migration.includes('pg_advisory_xact_lock'));
  assert(migration.includes("jsonb_build_object('idempotent_replay', true)"));
});
check('proof submission requires pending state before the deadline', () => {
  assert(/payment_status = 'pending_payment'[\s\S]{0,180}payment_expires_at > clock_timestamp\(\)/.test(submitProofFunction));
  assert(submitProofFunction.includes("status not in ('cancelled', 'refunded')"));
  assert(submitProofFunction.includes("payment_status = 'awaiting_verification'"));
  assert(submitProofFunction.includes('payment_expires_at = null'));
});
check('proof submission after expiry triggers expiry instead', () => {
  assert(migration.includes('perform public._expire_instapay_order_locked(p_order_id);'));
});
check('browser has no direct paid-state update path', () => {
  assert(!client.match(/\.from\(['"]orders['"]\)[\s\S]{0,100}\.update\(\{[^}]*payment_status/));
  assert(migration.includes('revoke all on function public.confirm_instapay_payment(uuid, text) from anon'));
});
check('admin confirm and reject require Express JWT', () => {
  assert(server.includes("app.post('/api/admin/orders/:id/instapay/confirm', requireAuth"));
  assert(server.includes("app.post('/api/admin/orders/:id/instapay/reject', requireAuth"));
});
check('confirmation accepts awaiting verification without a deadline', () => {
  assert(confirmPaymentFunction.includes("v_order.payment_status <> 'awaiting_verification'"));
  assert(confirmPaymentFunction.includes("payment_status = 'awaiting_verification'"));
  assert(!confirmPaymentFunction.includes('payment_expires_at > clock_timestamp()'));
  assert(confirmPaymentFunction.includes('payment_expires_at = null'));
});
check('duplicate confirmation is idempotent', () => {
  assert(migration.includes("if v_order.payment_status = 'paid' then"));
  assert(migration.includes("jsonb_build_object('changed', false)"));
});
check('expiry restores stock and records a durable marker', () => {
  assert(migration.includes("set payment_status = 'expired'"));
  assert(migration.includes('set stock_restored_at = clock_timestamp()'));
});
check('repeated restoration cannot add stock twice', () => {
  assert(migration.includes('or v_order.stock_restored_at is not null'));
  assert(migration.includes('and stock_restored_at is null'));
});
check('expiry and confirmation serialize on the order row', () => {
  assert((migration.match(/from public\.orders[\s\S]{0,140}for update;/g) || []).length >= 5);
  assert(migration.includes('for update skip locked'));
});
check('expiry targets pending payment only', () => {
  assert(expiryFunction.includes("v_order.payment_status is distinct from 'pending_payment'"));
  assert(expiryFunction.includes('v_order.payment_expires_at is null'));
  assert(!expiryFunction.includes("payment_status not in ('pending_payment', 'awaiting_verification')"));
  assert(expirySweepFunction.includes("payment_status = 'pending_payment'"));
  assert(!expirySweepFunction.includes("payment_status in ('pending_payment', 'awaiting_verification')"));
  assert(expirySweepFunction.includes('payment_expires_at <= clock_timestamp()'));
});
check('awaiting review permits a null deadline', () => {
  assert(proofReviewMigration.includes('drop constraint if exists orders_instapay_expiry_required_check'));
  assert(proofReviewMigration.includes("payment_status is distinct from 'pending_payment'"));
});
check('rejection restores once and records a reason', () => {
  assert(migration.includes("set payment_status = 'rejected'"));
  assert(migration.includes('payment_rejection_reason = v_reason'));
  assert(migration.includes('perform public._restore_instapay_stock_locked(p_order_id)'));
  assert(rejectPaymentFunction.includes("payment_status = 'awaiting_verification'"));
  assert(rejectPaymentFunction.includes('payment_expires_at = null'));
});
check('transaction references are normalized and unique', () => {
  assert(migration.includes('orders_instapay_payment_reference_key'));
  assert(migration.includes("upper(regexp_replace"));
});
check('proof type, size, signature and filename are server-controlled', () => {
  assert(server.includes('INSTAPAY_MAX_PROOF_BYTES = 5 * 1024 * 1024'));
  assert(server.includes('detectedProofExtension'));
  assert(server.includes('crypto.randomUUID()'));
});
check('proof storage is private and previews are short-lived', () => {
  assert(migration.includes("'instapay-proofs',\n  'instapay-proofs',\n  false"));
  assert(server.includes('.createSignedUrl(order.payment_proof_path, 60)'));
  assert(!server.includes('getPublicUrl(order.payment_proof_path'));
});
check('refresh recovery persists token and uses server time', () => {
  assert(html.includes("instapay:'TICK_v1_instapay_payment'"));
  assert(html.includes('serverMs-Date.now()'));
  assert(html.includes('restoreInstapayPayment()'));
});
check('awaiting-review UI has no countdown or proof form', () => {
  assert(html.includes("const paymentWindowActive=status==='pending_payment'"));
  assert(html.includes("const awaitingReview=status==='awaiting_verification'"));
  assert(html.includes('Proof submitted successfully'));
  assert(html.includes('Your checkout is complete. We will review the transfer'));
  assert(html.includes("const timer=paymentWindowActive?"));
  assert(html.includes("state+(paymentWindowActive?paymentDetails:'')+form"));
  assert(html.includes("if(order.payment_status!=='pending_payment')return"));
  assert(!html.includes('Payment must be confirmed before the timer reaches zero.'));
  const pendingHtml = renderInstapayStatus('pending_payment');
  assert(pendingHtml.includes('id="ip-countdown"'));
  assert(pendingHtml.includes('id="ip-ref"'));
  assert(pendingHtml.includes('Open InstaPay transfer link'));
  const awaitingHtml = renderInstapayStatus('awaiting_verification', {
    payment_reference: 'REVIEWREF001',
  });
  assert(awaitingHtml.includes('Proof submitted successfully'));
  assert(awaitingHtml.includes('REVIEWREF001'));
  assert(!awaitingHtml.includes('id="ip-countdown"'));
  assert(!awaitingHtml.includes('id="ip-ref"'));
  assert(!awaitingHtml.includes('Open InstaPay transfer link'));
  assert(!awaitingHtml.includes('00:00'));
});
check('admin bootstrap expiry sweep is safe for awaiting review', () => {
  assert(server.includes("sbAdmin.rpc('expire_instapay_orders')"));
  assert(expirySweepFunction.includes("payment_status = 'pending_payment'"));
});
check('disposable SQL covers post-proof persistence and the lock race', () => {
  assert(proofReviewVerification.includes('begin;'));
  assert(proofReviewVerification.includes('rollback;'));
  assert(proofReviewVerification.includes("v_result ->> 'payment_status' <> 'awaiting_verification'"));
  assert(proofReviewVerification.includes("payment_expires_at = clock_timestamp() - interval '1 day'"));
  assert(proofReviewVerification.includes('admin could not confirm after the original deadline'));
  assert(proofReviewVerification.includes('admin could not reject awaiting review after the original deadline'));
  assert(proofReviewVerification.includes('repeated expiry restored stock twice'));
  assert(proofReviewVerification.includes('PROOF WINS BEFORE DEADLINE'));
  assert(proofReviewVerification.includes('EXPIRY WINS AFTER DEADLINE'));
});
check('historical orders are protected by NOT VALID constraints', () => {
  assert((migration.match(/\) not valid;/g) || []).length >= 2);
});
check('dashboard exposes escaped InstaPay verification fields', () => {
  assert(html.includes('instapayAdminDetails(o)'));
  assert(html.includes("escHTML(o.paymentReference||'—')"));
  assert(server.includes('paymentProofAvailable: !!row.payment_proof_path'));
});
check('preview checkout has no automatic notification side effects', () => {
  assert(!edge.includes('RESEND_API_KEY'));
  assert(!edge.includes('firebase.googleapis.com'));
  assert(!edge.includes('sendAdminPushNotifications'));
});
check('checkout conditionally exposes only COD and InstaPay', () => {
  assert(checkout.includes("selPay(\\'COD\\')"));
  assert(checkout.includes("selPay(\\'InstaPay\\')"));
  assert(!checkout.includes('po-visa'));
  assert(!checkout.includes("selPay(\\'Valu\\')"));
  assert(!checkout.includes("selPay(\\'Sympl\\')"));
  assert(/S\.ckStep===4&&S\.selPay==='InstaPay'&&S\.instapay\)\{\s*html=instapayPaymentHTML\(\)/.test(checkout));
  assert(sampleEnv.includes('TICK_INSTAPAY_RECIPIENT_NAME=replace-with-recipient-name'));
  assert(!html.includes('moazessam991'));
});
check('InstaPay rejection is isolated from generic cancellation', () => {
  assert(server.includes("app.post('/api/admin/orders/:id/instapay/reject', requireAuth"));
  assert(html.includes('sbRejectInstapayPayment(id,reason.trim())'));
  assert(cancellationMigration.includes("if v_order.payment_method = 'InstaPay' then"));
  assert(cancellationMigration.includes("'reason', 'use_instapay_payment_action'"));
});
check('generic cancellation uses one locked database function', () => {
  assert(cancellationMigration.includes('create or replace function public.cancel_order_with_stock'));
  assert(/from public\.orders[\s\S]{0,100}for update;/.test(cancellationMigration));
  assert(server.includes("sbAdmin.rpc(\n      'cancel_order_with_stock'"));
  assert(!server.includes(".update({ status: 'cancelled'"));
});
check('fulfilment updates serialize with cancellation and cannot regress', () => {
  assert(cancellationMigration.includes('create or replace function public.update_order_fulfillment_status'));
  assert(cancellationMigration.includes("'order_status_regression_blocked'"));
  assert(cancellationMigration.includes("'terminal_order_status'"));
  assert(server.includes("sbAdmin.rpc('update_order_fulfillment_status'"));
  assert(!server.match(/\.from\(['"]orders['"]\)[\s\S]{0,180}\.update\(\{ status/));
});
check('generic cancellation restores persisted aggregated quantities', () => {
  assert(cancellationMigration.includes('create or replace function public._restore_order_stock_locked'));
  assert((cancellationMigration.match(/sum\(quantity\)::integer as quantity/g) || []).length >= 2);
  assert(cancellationMigration.includes('from public.order_items'));
  assert(cancellationMigration.includes('order by product.id'));
  assert(cancellationMigration.includes('for update of product'));
});
check('COD duplicate cancellation is harmless and stock is marked once', () => {
  assert(cancellationMigration.includes("if v_order.status = 'cancelled' then"));
  assert(cancellationMigration.includes("'reason', 'already_cancelled'"));
  assert(cancellationMigration.includes('and stock_restored_at is null'));
});
check('generic cancellation protects paid, refunded and fulfilled orders', () => {
  assert(cancellationMigration.includes("'paid_order_cancellation_unsupported'"));
  assert(cancellationMigration.includes("'refunded_order_protected'"));
  assert(cancellationMigration.includes("v_order.status not in ('pending', 'confirmed')"));
  assert(server.includes("refund_requires_dedicated_workflow"));
});
check('bulk and single cancel actions use the protected status endpoint', () => {
  assert(html.includes("updOS(\\'"));
  assert(html.includes("ids.map(id=>sbUpdateOrderStatus(id,st))"));
  assert(client.includes("'/api/admin/orders/' + encodeURIComponent(orderId) + '/status'"));
});
check('hidden card callbacks cannot bypass locked cancel or confirmation', () => {
  assert(paymob.includes("supabase.rpc('cancel_order_with_stock'"));
  assert(paymob.includes("supabase.rpc('confirm_card_payment'"));
  assert(!paymob.match(/\.from\(['"]orders['"]\)[\s\S]{0,120}\.update\(/));
  assert(cancellationMigration.includes('create or replace function public.confirm_card_payment'));
});
check('Paymob callback verifies HMAC before trusting the callback', () => {
  assert(paymob.includes("hash: 'SHA-512'"));
  assert(paymob.includes('safeEqualHex(suppliedHmac, expectedHmac)'));
  assert(paymob.indexOf('safeEqualHex(suppliedHmac, expectedHmac)') < paymob.indexOf("supabase.rpc('confirm_card_payment'"));
});
check('card confirmation validates method, amount and terminal state', () => {
  assert(cancellationMigration.includes("v_order.payment_method is distinct from 'Visa'"));
  assert(cancellationMigration.includes("round(p_amount, 2) <> round(v_order.total_amount, 2)"));
  assert(cancellationMigration.includes("v_order.status not in ('pending', 'confirmed')"));
  assert(cancellationMigration.includes('or v_order.stock_restored_at is not null'));
});
check('order UPDATE policies available to browser roles are removed', () => {
  assert(cancellationMigration.includes("tablename = 'orders'"));
  assert(cancellationMigration.includes("cmd in ('UPDATE', 'ALL')"));
  assert(cancellationMigration.includes("array['public', 'anon', 'authenticated']::name[]"));
});
check('browser roles cannot directly update product stock', () => {
  assert(cancellationMigration.includes('create or replace function public.prevent_browser_product_stock_change'));
  assert(cancellationMigration.includes("auth.role() in ('anon', 'authenticated')"));
  assert(cancellationMigration.includes("message = 'direct_product_stock_update_forbidden'"));
  assert(cancellationMigration.includes('before update of stock_quantity on public.products'));
});
check('active reservations prevent product deletion', () => {
  assert(cancellationMigration.includes('create or replace function public.prevent_unsettled_order_product_delete'));
  assert(cancellationMigration.includes('protect_unsettled_order_product_stock'));
  assert(cancellationMigration.includes("message = 'product_has_unsettled_order'"));
});
check('cron extension and schema are validated before cron.job is queried', () => {
  const extensionAt = cancellationMigration.indexOf('create extension if not exists pg_cron');
  const schemaCheckAt = cancellationMigration.indexOf("to_regnamespace('cron')");
  const jobQueryAt = cancellationMigration.indexOf('from cron.job');
  assert(extensionAt >= 0 && schemaCheckAt > extensionAt && jobQueryAt > schemaCheckAt);
});
check('cron ten-second capability is version-gated', () => {
  assert(cancellationMigration.includes('pg_cron 1.5 or newer is required'));
  assert(cancellationMigration.includes("'10 seconds'"));
  assert(cancellationMigration.includes('instapay_cron_version_unsupported'));
});
check('cron setup replaces wrong and duplicate jobs safely', () => {
  assert(cancellationMigration.includes('perform cron.unschedule(v_job.jobid)'));
  assert(cancellationMigration.includes("jobname = 'tick-instapay-expiry'"));
  assert(cancellationMigration.includes("position('expire_instapay_orders' in lower(command)) > 0"));
  assert(cancellationMigration.includes("'select public.expire_instapay_orders();'"));
  assert(cancellationMigration.includes("and active is true"));
  assert(cancellationMigration.indexOf('cron.unschedule') < cancellationMigration.lastIndexOf('cron.schedule'));
});
check('cron verification reports installation, configuration and run history', () => {
  assert(cronVerification.includes('extension_installed'));
  assert(cronVerification.includes('matching_job_count'));
  assert(cronVerification.includes('cron.job_run_details'));
  assert(cronVerification.includes('active'));
});
check('all new mutating RPCs are service-role only', () => {
  for (const signature of [
    'public.cancel_order_with_stock(uuid, text)',
    'public.update_order_fulfillment_status(uuid, text)',
    'public.confirm_card_payment(uuid, text, numeric)',
  ]) {
    assert(cancellationMigration.includes(`revoke all on function ${signature} from anon`));
    assert(cancellationMigration.includes(`revoke all on function ${signature} from authenticated`));
    assert(cancellationMigration.includes(`grant execute on function ${signature} to service_role`));
  }
  for (const signature of [
    'public.submit_instapay_payment_proof(uuid, text, text, text, text)',
    'public.confirm_instapay_payment(uuid, text)',
    'public.reject_instapay_payment(uuid, text)',
    'public.expire_instapay_orders()',
  ]) {
    assert(proofReviewMigration.includes(`revoke all on function ${signature} from anon`));
    assert(proofReviewMigration.includes(`revoke all on function ${signature} from authenticated`));
    assert(proofReviewMigration.includes(`grant execute on function ${signature} to service_role`));
  }
});
check('payment transitions never modify the trusted order total', () => {
  const transitionSql = cancellationMigration.slice(cancellationMigration.indexOf('create or replace function public.cancel_order_with_stock'));
  assert(!/set[\s\S]{0,80}total_amount\s*=/.test(transitionSql));
});
check('generic cancellation fails instead of silently losing unrestorable stock', () => {
  assert(cancellationMigration.includes("message = 'order_items_missing'"));
  assert(cancellationMigration.includes("message = 'order_stock_restore_unavailable'"));
  assert(cancellationMigration.includes("message = 'order_stock_restore_failed'"));
});

const PORT = 38486;
function request(method, requestPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: requestPath,
      method,
      headers,
    }, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await request('GET', '/api/health');
      if (response.status === 200) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('test server did not start');
}

async function endpointChecks() {
  const dataDir = path.join(root, 'data', `instapay-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      TICK_HTML: path.join(dataDir, '.no-html'),
      TICK_DB_PATH: path.join(dataDir, 'test.sqlite'),
      TICK_ADMIN_PASSWORD: 'test-only-password',
      TICK_JWT_SECRET: 'test-only-jwt-secret-at-least-thirty-two-characters',
      SUPABASE_SERVICE_ROLE_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForReady();
    const id = '11111111-1111-4111-8111-111111111111';
    let response = await request('GET', `/api/public/instapay/orders/${id}/status`);
    assert.strictEqual(response.status, 401, 'status lookup without order token must be denied');

    response = await request('POST', `/api/admin/orders/${id}/instapay/confirm`, Buffer.from('{}'), {
      'Content-Type': 'application/json',
      'Content-Length': 2,
    });
    assert.strictEqual(response.status, 401, 'anonymous confirmation must be denied');

    response = await request('POST', `/api/admin/orders/${id}/instapay/reject`, Buffer.from('{}'), {
      'Content-Type': 'application/json',
      'Content-Length': 2,
    });
    assert.strictEqual(response.status, 401, 'anonymous rejection must be denied');

    response = await request('GET', `/api/admin/orders/${id}/instapay/proof`);
    assert.strictEqual(response.status, 401, 'anonymous proof preview must be denied');

    response = await request('PATCH', `/api/admin/orders/${id}/status`, Buffer.from('{"status":"cancelled"}'), {
      'Content-Type': 'application/json',
      'Content-Length': 22,
    });
    assert.strictEqual(response.status, 401, 'anonymous generic cancellation must be denied');

    response = await request('POST', `/api/public/instapay/orders/${id}/proof`, Buffer.from('not an image'), {
      'Content-Type': 'text/plain',
      'Content-Length': 12,
    });
    assert.strictEqual(response.status, 415, 'unexpected proof MIME type must be denied');

    const fakePng = Buffer.from('not really a png');
    response = await request('POST', `/api/public/instapay/orders/${id}/proof`, fakePng, {
      'Content-Type': 'image/png',
      'Content-Length': fakePng.length,
      'X-Payment-Access-Token': '11111111-1111-4111-8111-111111111111',
      'X-Payment-Reference': 'ABC123456',
      'X-Payment-Sender-Name': 'Test%20Sender',
    });
    assert.strictEqual(response.status, 415, 'fake image signature must be denied');

    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0);
    response = await request('POST', `/api/public/instapay/orders/${id}/proof`, oversized, {
      'Content-Type': 'image/png',
      'Content-Length': oversized.length,
      'X-Payment-Access-Token': '11111111-1111-4111-8111-111111111111',
      'X-Payment-Reference': 'ABC123456',
      'X-Payment-Sender-Name': 'Test%20Sender',
    });
    assert.strictEqual(response.status, 413, 'oversized proof must be denied');

    response = await request('POST', `/api/public/instapay/orders/${id}/proof`, Buffer.from('bad'), {
      'Content-Type': 'text/plain',
      'Content-Length': 3,
    });
    assert.strictEqual(response.status, 415, 'fourth proof request should still be validated');
    response = await request('POST', `/api/public/instapay/orders/${id}/proof`, Buffer.from('bad'), {
      'Content-Type': 'text/plain',
      'Content-Length': 3,
    });
    assert.strictEqual(response.status, 415, 'fifth proof request should still be validated');
    response = await request('POST', `/api/public/instapay/orders/${id}/proof`, Buffer.from('bad'), {
      'Content-Type': 'text/plain',
      'Content-Length': 3,
    });
    assert.strictEqual(response.status, 429, 'proof submission rate limit must activate');

    console.log(`InstaPay focused checks OK (${results.length} source controls + 9 endpoint controls)`);
    for (const result of results) console.log(`  ✓ ${result}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

endpointChecks().catch((error) => {
  console.error('InstaPay focused checks FAIL', error);
  process.exit(1);
});

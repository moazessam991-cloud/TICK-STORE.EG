'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260725020000_confirmed_order_cancellation.sql');
const verification = read('supabase/verification/test_confirmed_order_cancellation.sql');
const previousCancellationMigration = read('supabase/migrations/20260724020000_order_cancellation_cron_hardening.sql');
const proofReviewMigration = read('supabase/migrations/20260725010000_instapay_proof_stops_expiry.sql');
const server = read('server/index.js');
const client = read('public/supabase-client.js');
const html = read('public/index.html');

function sqlFunction(source, name) {
  const start = source.indexOf(`create or replace function public.${name}`);
  assert(start >= 0, `missing ${name}`);
  const remainder = source.slice(start);
  const next = remainder.indexOf('\ncreate or replace function public.', 1);
  return next >= 0 ? remainder.slice(0, next) : remainder;
}

const restoreFunction = sqlFunction(migration, '_restore_order_stock_locked');
const cancelFunction = sqlFunction(migration, 'cancel_order_with_stock');
const fulfillmentFunction = sqlFunction(previousCancellationMigration, 'update_order_fulfillment_status');
const rejectFunction = sqlFunction(proofReviewMigration, 'reject_instapay_payment');
const checks = [];
function check(name, test) {
  test();
  checks.push(name);
}

check('confirmed to cancelled is explicitly valid', () => {
  assert(cancelFunction.includes("v_order.status is not distinct from 'confirmed'"));
  assert(cancelFunction.includes("set status = 'cancelled'"));
  assert(verification.includes('confirmed order did not cancel'));
});

check('status and exact stock restoration share one RPC transaction', () => {
  const statusUpdate = cancelFunction.indexOf("set status = 'cancelled'");
  const restoreCall = cancelFunction.indexOf('public._restore_order_stock_locked(p_order_id)');
  assert(statusUpdate >= 0 && restoreCall > statusUpdate);
  assert(!server.match(/\.from\(['"]orders['"]\)[\s\S]{0,180}\.update\(\{ status/));
});

check('order and product rows are locked in stable order', () => {
  assert(/from public\.orders[\s\S]{0,100}for update;/.test(cancelFunction));
  assert(/from public\.orders[\s\S]{0,100}for update;/.test(restoreFunction));
  assert(restoreFunction.includes('order by product.id'));
  assert(restoreFunction.includes('for update of product'));
});

check('persisted order-item quantities drive the restock', () => {
  assert((restoreFunction.match(/sum\(quantity\)::integer as quantity/g) || []).length >= 2);
  assert(restoreFunction.includes('from public.order_items'));
});

check('stock_restored_at is the one durable idempotency marker', () => {
  assert(restoreFunction.includes('v_order.stock_restored_at is not null'));
  assert(restoreFunction.includes('and stock_restored_at is null'));
  assert(restoreFunction.includes('set stock_restored_at = clock_timestamp()'));
  assert(!migration.includes('stock_restore_count'));
});

check('duplicate paid InstaPay cancellation is harmless', () => {
  const duplicateGuard = cancelFunction.indexOf("v_order.status is not distinct from 'cancelled'");
  const paymentActionGuard = cancelFunction.indexOf("'reason', 'use_instapay_payment_action'");
  assert(duplicateGuard >= 0 && paymentActionGuard > duplicateGuard);
  assert(cancelFunction.includes("'reason', 'already_cancelled'"));
  assert(verification.includes('duplicate paid InstaPay cancellation restored twice'));
});

check('paid cancellation exception is limited to confirmed InstaPay', () => {
  assert(cancelFunction.includes("v_order.payment_method is not distinct from 'InstaPay'"));
  assert(cancelFunction.includes("v_order.payment_status is not distinct from 'paid'"));
  assert(cancelFunction.includes("'paid_order_cancellation_unsupported'"));
  assert(verification.includes('paid Visa order was cancelled'));
});

check('pending and awaiting-verification InstaPay still use payment rejection', () => {
  assert(cancelFunction.includes("'reason', 'use_instapay_payment_action'"));
  assert(rejectFunction.includes("payment_status not in ('pending_payment', 'awaiting_verification')"));
  assert(rejectFunction.includes('public._restore_instapay_stock_locked(p_order_id)'));
  assert(verification.includes('awaiting-verification generic cancellation changed behavior'));
});

check('fulfilled, terminal, and regression protections remain intact', () => {
  assert(cancelFunction.includes("v_order.status not in ('pending', 'confirmed')"));
  assert(cancelFunction.includes("'refunded_order_protected'"));
  assert(fulfillmentFunction.includes("'terminal_order_status'"));
  assert(fulfillmentFunction.includes("'order_status_regression_blocked'"));
  assert(verification.includes('shipped order was cancelled'));
  assert(verification.includes('cancelled order was revived'));
});

check('single and bulk UI actions use the protected endpoint and refresh', () => {
  assert(client.includes("'/api/admin/orders/' + encodeURIComponent(orderId) + '/status'"));
  assert(html.includes('ids.map(id=>sbUpdateOrderStatus(id,st))'));
  assert(html.includes('await __tickAdminBootstrapFromApi()'));
  assert(!html.match(/stock_quantity\s*\+=/));
  assert(verification.includes('bulk fixture A did not cancel'));
  assert(verification.includes('bulk fixture B did not cancel'));
});

check('the endpoint accepts success and idempotency but controls invalid transitions', () => {
  assert(server.includes("cancelledOrder.reason !== 'already_cancelled'"));
  assert(server.includes('return res.status(409).json({ error: cancelledOrder.reason'));
  assert(server.includes('return res.json({ ok: true, order: cancelledOrder })'));
});

check('concurrent duplicate requests serialize before checking the marker', () => {
  const lock = cancelFunction.indexOf('for update;');
  const duplicate = cancelFunction.indexOf("'reason', 'already_cancelled'");
  const restore = cancelFunction.indexOf('public._restore_order_stock_locked(p_order_id)');
  assert(lock >= 0 && duplicate > lock && restore > duplicate);
  assert(verification.includes('CONCURRENT DUPLICATE CANCELLATION'));
  assert(verification.includes('one changed=true result'));
});

check('replacement RPC remains service-role only', () => {
  assert(migration.includes('revoke all on function public.cancel_order_with_stock(uuid, text) from anon'));
  assert(migration.includes('revoke all on function public.cancel_order_with_stock(uuid, text) from authenticated'));
  assert(migration.includes('grant execute on function public.cancel_order_with_stock(uuid, text) to service_role'));
});

const API_PORT = 38489;
const RPC_PORT = 38490;
const VALID_ID = '11111111-1111-4111-8111-111111111111';
const INVALID_ID = '22222222-2222-4222-8222-222222222222';

function request(port, method, requestPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const requestBody = body == null ? null : Buffer.from(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        ...(requestBody ? { 'Content-Length': requestBody.length } : {}),
        ...headers,
      },
    }, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    if (requestBody) req.write(requestBody);
    req.end();
  });
}

async function waitForApi() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await request(API_PORT, 'GET', '/api/health');
      if (response.status === 200) return;
    } catch {
      // The child server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('test API did not start');
}

async function endpointChecks() {
  let validCalls = 0;
  const rpcServer = http.createServer((req, res) => {
    let requestBody = '';
    req.on('data', (chunk) => { requestBody += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/rest/v1/rpc/cancel_order_with_stock') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'not_found' }));
        return;
      }
      const payload = JSON.parse(requestBody || '{}');
      const invalid = payload.p_order_id === INVALID_ID;
      if (!invalid) validCalls += 1;
      const result = invalid
        ? {
            id: INVALID_ID,
            status: 'shipped',
            changed: false,
            reason: 'order_state_not_cancellable',
          }
        : {
            id: VALID_ID,
            status: 'cancelled',
            payment_status: 'paid',
            stock_restored_at: '2026-07-25T12:00:00Z',
            changed: validCalls === 1,
            reason: validCalls === 1 ? null : 'already_cancelled',
          };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  await new Promise((resolve, reject) => {
    rpcServer.once('error', reject);
    rpcServer.listen(RPC_PORT, '127.0.0.1', resolve);
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-order-status-'));
  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      TICK_HTML: path.join(dataDir, '.no-html'),
      TICK_DB_PATH: path.join(dataDir, 'test.sqlite'),
      TICK_ADMIN_PASSWORD: 'test-only-password',
      TICK_JWT_SECRET: 'test-only-jwt-secret-at-least-thirty-two-characters',
      SUPABASE_URL: `http://127.0.0.1:${RPC_PORT}`,
      SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForApi();
    const login = await request(
      API_PORT,
      'POST',
      '/api/auth/login',
      JSON.stringify({ password: 'test-only-password' }),
      { 'Content-Type': 'application/json' }
    );
    assert.strictEqual(login.status, 200, 'test admin login failed');
    const token = JSON.parse(login.body).token;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    let response = await request(
      API_PORT,
      'PATCH',
      `/api/admin/orders/${VALID_ID}/status`,
      JSON.stringify({ status: 'cancelled' }),
      headers
    );
    assert.strictEqual(response.status, 200, 'confirmed cancellation still returned a conflict');
    assert.strictEqual(JSON.parse(response.body).order.status, 'cancelled');

    response = await request(
      API_PORT,
      'PATCH',
      `/api/admin/orders/${VALID_ID}/status`,
      JSON.stringify({ status: 'cancelled' }),
      headers
    );
    assert.strictEqual(response.status, 200, 'idempotent duplicate cancellation was rejected');
    assert.strictEqual(JSON.parse(response.body).order.reason, 'already_cancelled');

    response = await request(
      API_PORT,
      'PATCH',
      `/api/admin/orders/${INVALID_ID}/status`,
      JSON.stringify({ status: 'cancelled' }),
      headers
    );
    assert.strictEqual(response.status, 409, 'invalid transition did not return a controlled conflict');
    assert.strictEqual(JSON.parse(response.body).error, 'order_state_not_cancellable');

    console.log(`Order-status cancellation checks OK (${checks.length} source/database controls + 3 endpoint controls)`);
    for (const name of checks) console.log(`  ✓ ${name}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => rpcServer.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

endpointChecks().catch((error) => {
  console.error('Order-status cancellation checks FAIL', error);
  process.exit(1);
});

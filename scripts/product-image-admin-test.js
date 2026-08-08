#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const serverSource = read('server/index.js');
const clientSource = read('public/supabase-client.js');
const htmlSource = read('public/index.html');
const migration = read('supabase/migrations/20260802010000_product_images_storage_hardening.sql');
const verification = read('supabase/verification/verify_product_images_storage_hardening.sql');

const API_PORT = 38493;
const SUPABASE_PORT = 38494;
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const IMAGE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_IMAGE_ID = '33333333-3333-4333-8333-333333333333';
const SERVER_OBJECT_ID = '44444444-4444-4444-8444-444444444444';
const SERVER_PATH = `${PRODUCT_ID}/${SERVER_OBJECT_ID}.png`;

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
}

function functionBlock(source, name) {
  const start = source.indexOf(`create or replace function public.${name}`);
  assert(start >= 0, `missing ${name}`);
  const rest = source.slice(start);
  const next = rest.indexOf('\ncreate or replace function public.', 1);
  return next >= 0 ? rest.slice(0, next) : rest;
}

check('all four image/product mutation routes require the Admin JWT', () => {
  for (const route of [
    "'/api/admin/products/:id/images',\n  requireAuth",
    "'/api/admin/product-images/:id',\n  requireAuth",
    "'/api/admin/products/:id/images/order',\n  requireAuth",
    "'/api/admin/products/:id',\n  requireAuth",
  ]) assert(serverSource.includes(route), `route is not JWT protected: ${route}`);
  assert(serverSource.includes("algorithms: ['HS256']"));
});

check('upload enforces MIME, five MiB, magic bytes and server paths', () => {
  assert(serverSource.includes('PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024'));
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    assert(serverSource.includes(`['${mime}'`));
  }
  assert(serverSource.includes('detectedProofExtension(req.body)'));
  assert(serverSource.includes('`${productId}/${crypto.randomUUID()}.${actualExtension}`'));
  assert(!clientSource.includes('storage_path:'));
});

check('browser contains no direct product image or product-row mutation', () => {
  const browserSource = `${clientSource}\n${htmlSource}`;
  assert(!/\.storage[\s\S]{0,160}\.(upload|remove)\s*\(/i.test(browserSource));
  assert(!/\.from\(['"]product_images['"]\)[\s\S]{0,240}\.(insert|update|delete)\s*\(/i.test(browserSource));
  assert(!/\.from\(['"]products['"]\)[\s\S]{0,240}\.delete\s*\(/i.test(browserSource));
  assert(!clientSource.includes('sbSetProductImagePosition'));
  assert(clientSource.includes("body: JSON.stringify({ image_ids: imageIds })"));
});

check('reorder is one locked transactional RPC with canonical position', () => {
  const reorder = functionBlock(migration, 'reorder_product_images_admin');
  assert(reorder.includes('for update;'));
  assert(reorder.includes("message = 'duplicate_product_image_id'"));
  assert(reorder.includes("message = 'product_image_set_mismatch'"));
  assert(reorder.includes('set position = (requested.ordinality - 1)::integer'));
  assert(serverSource.includes("sbAdmin.rpc(\n      'reorder_product_images_admin'"));
});

check('product deletion remains protected and transactional', () => {
  const productDelete = functionBlock(migration, 'delete_product_admin');
  assert(productDelete.includes('delete from public.products'));
  assert(productDelete.includes('product_has_unsettled_order'));
  assert(serverSource.includes("productDeleteError.message === 'product_image_storage_path_missing'"));
  assert(serverSource.includes("return res.status(409).json({ error: 'product_has_unsettled_order' })"));
});

check('new administrative RPCs are service-role only', () => {
  for (const signature of [
    'insert_product_image_admin(uuid, text, text)',
    'delete_product_image_admin(uuid)',
    'reorder_product_images_admin(uuid, uuid[])',
    'delete_product_admin(uuid)',
  ]) {
    assert(migration.includes(`revoke all on function public.${signature} from public, anon, authenticated`));
    assert(migration.includes(`grant execute on function public.${signature} to service_role`));
  }
});

check('Storage hardening preserves public SELECT and scopes mutation denial', () => {
  assert(migration.includes('create policy product_images_storage_public_read'));
  assert(/for select\s+to public\s+using \(bucket_id = 'product-images'\)/i.test(migration));
  assert(migration.includes("p.polcmd in ('a', 'w', 'd', '*')"));
  assert(migration.includes("bucket_id is distinct from %L"));
  assert(migration.includes('v_scoped_other_bucket'));
  assert(migration.includes("if v_scope ~* 'instapay-proofs'"));
  assert(migration.includes('product_images_storage_policy_scope_ambiguous'));
  assert(!/bucket_id\s*(=|is distinct from)\s*['"]instapay-proofs['"]/i.test(migration));
  assert(!/\b(insert|update|delete)\s+(into|from)\s+storage\.(buckets|objects)\b/i.test(migration));
  assert(verification.includes('unsafe_policy_count'));
});

function request(method, requestPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null
      ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: API_PORT,
      method,
      path: requestPath,
      headers: {
        ...(payload ? { 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForApi() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await request('GET', '/api/health');
      if (response.status === 200) return;
    } catch {
      // Child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('product image test API did not start');
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function endpointChecks() {
  const state = {
    mode: 'normal',
    requests: [],
  };

  const supabaseServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: req.method, url: req.url, body });
      const requestUrl = new URL(req.url, `http://127.0.0.1:${SUPABASE_PORT}`);

      if (req.method === 'GET' && requestUrl.pathname === '/rest/v1/products') {
        if (state.mode === 'nonexistent') return jsonResponse(res, 200, null);
        return jsonResponse(res, 200, { id: PRODUCT_ID, is_active: true });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/rest/v1/product_images') {
        if (requestUrl.searchParams.has('id')) {
          return jsonResponse(res, 200, {
            id: IMAGE_ID,
            product_id: PRODUCT_ID,
            storage_path: SERVER_PATH,
          });
        }
        return jsonResponse(res, 200, [
          { id: IMAGE_ID, product_id: PRODUCT_ID },
        ]);
      }

      if (req.method === 'POST' && requestUrl.pathname.startsWith('/storage/v1/object/product-images/')) {
        return jsonResponse(res, 200, { Key: requestUrl.pathname.slice('/storage/v1/object/'.length) });
      }

      if (req.method === 'DELETE' && requestUrl.pathname === '/storage/v1/object/product-images') {
        return jsonResponse(res, 200, { message: 'Successfully deleted' });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/rest/v1/rpc/insert_product_image_admin') {
        if (state.mode === 'insert_failure') {
          return jsonResponse(res, 400, { message: 'forced_insert_failure', code: 'XX000' });
        }
        return jsonResponse(res, 200, {
          id: IMAGE_ID,
          product_id: PRODUCT_ID,
          url: `http://127.0.0.1:${SUPABASE_PORT}/storage/v1/object/public/product-images/${SERVER_PATH}`,
          position: 0,
          created_at: '2026-08-02T00:00:00Z',
        });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/rest/v1/rpc/delete_product_image_admin') {
        return jsonResponse(res, 200, {
          found: true,
          image_id: IMAGE_ID,
          product_id: PRODUCT_ID,
          storage_path: SERVER_PATH,
        });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/rest/v1/rpc/reorder_product_images_admin') {
        return jsonResponse(res, 200, [{
          id: IMAGE_ID,
          product_id: PRODUCT_ID,
          url: 'https://example.invalid/image.png',
          position: 0,
        }]);
      }

      if (req.method === 'POST' && requestUrl.pathname === '/rest/v1/rpc/delete_product_admin') {
        if (state.mode === 'protected_delete') {
          return jsonResponse(res, 400, { message: 'product_has_unsettled_order', code: 'P0001' });
        }
        return jsonResponse(res, 200, {
          found: true,
          product_id: PRODUCT_ID,
          image_count: 1,
          storage_paths: [SERVER_PATH],
        });
      }

      return jsonResponse(res, 404, { message: 'mock_route_not_found', path: req.url });
    });
  });

  await new Promise((resolve, reject) => {
    supabaseServer.once('error', reject);
    supabaseServer.listen(SUPABASE_PORT, '127.0.0.1', resolve);
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-product-images-'));
  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      TICK_HTML: path.join(dataDir, '.no-html'),
      TICK_DB_PATH: path.join(dataDir, 'test.sqlite'),
      TICK_ADMIN_PASSWORD: 'test-only-password',
      TICK_JWT_SECRET: 'test-only-jwt-secret-at-least-thirty-two-characters',
      SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
      SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk.toString(); });

  try {
    await waitForApi();
    const jsonHeaders = { 'Content-Type': 'application/json' };

    let response = await request('POST', `/api/admin/products/${PRODUCT_ID}/images`, Buffer.from('x'), {
      'Content-Type': 'image/png',
    });
    assert.strictEqual(response.status, 401, 'unauthenticated upload was not denied');

    response = await request('DELETE', `/api/admin/product-images/${IMAGE_ID}`);
    assert.strictEqual(response.status, 401, 'unauthenticated image delete was not denied');

    response = await request('PUT', `/api/admin/products/${PRODUCT_ID}/images/order`, '{}', jsonHeaders);
    assert.strictEqual(response.status, 401, 'unauthenticated reorder was not denied');

    response = await request('POST', `/api/admin/products/${PRODUCT_ID}/images`, Buffer.from('x'), {
      Authorization: 'Bearer malformed.jwt.value',
      'Content-Type': 'image/png',
    });
    assert.strictEqual(response.status, 401, 'malformed JWT was not denied');

    const login = await request('POST', '/api/auth/login', JSON.stringify({ password: 'test-only-password' }), jsonHeaders);
    assert.strictEqual(login.status, 200, 'admin fixture login failed');
    const token = JSON.parse(login.body).token;
    const auth = { Authorization: `Bearer ${token}` };

    response = await request('POST', `/api/admin/products/${PRODUCT_ID}/images`, Buffer.from('text'), {
      ...auth,
      'Content-Type': 'text/plain',
    });
    assert.strictEqual(response.status, 415, 'unsupported product-image MIME was accepted');

    response = await request('POST', `/api/admin/products/${PRODUCT_ID}/images`, Buffer.alloc(5 * 1024 * 1024 + 1), {
      ...auth,
      'Content-Type': 'image/png',
    });
    assert.strictEqual(response.status, 413, 'oversized product image was accepted');

    response = await request('POST', `/api/admin/products/${PRODUCT_ID}/images`, Buffer.from('not a png'), {
      ...auth,
      'Content-Type': 'image/png',
    });
    assert.strictEqual(response.status, 415, 'invalid product-image magic bytes were accepted');

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    state.mode = 'nonexistent';
    response = await request('POST', `/api/admin/products/${PRODUCT_ID}/images`, png, {
      ...auth,
      'Content-Type': 'image/png',
    });
    assert.strictEqual(response.status, 404, 'nonexistent product was not rejected');

    state.mode = 'insert_failure';
    state.requests.length = 0;
    response = await request('POST', `/api/admin/products/${PRODUCT_ID}/images`, png, {
      ...auth,
      'Content-Type': 'image/png',
    });
    assert.strictEqual(response.status, 500, 'database insert failure was not surfaced');
    assert(state.requests.some((entry) => entry.method === 'POST' && entry.url.includes('/storage/v1/object/product-images/')),
      'upload fixture did not reach Storage');
    assert(state.requests.some((entry) => entry.method === 'DELETE' && entry.url === '/storage/v1/object/product-images'),
      'uploaded object was not removed after database failure');

    state.mode = 'normal';
    state.requests.length = 0;
    response = await request('DELETE', `/api/admin/product-images/${IMAGE_ID}`,
      JSON.stringify({ storage_path: 'victim-bucket/arbitrary-secret.png', bucket: 'victim-bucket' }),
      { ...auth, ...jsonHeaders });
    assert.strictEqual(response.status, 200, 'safe image deletion fixture failed');
    const removal = state.requests.find((entry) => entry.method === 'DELETE' && entry.url === '/storage/v1/object/product-images');
    assert(removal, 'image delete did not clean up the fixed product-images bucket');
    assert(removal.body.includes(SERVER_PATH), 'image delete did not use the database-derived path');
    assert(!removal.body.includes('arbitrary-secret'), 'image delete trusted the browser-supplied path');

    state.requests.length = 0;
    response = await request('PUT', `/api/admin/products/${PRODUCT_ID}/images/order`,
      JSON.stringify({ image_ids: [IMAGE_ID, IMAGE_ID] }),
      { ...auth, ...jsonHeaders });
    assert.strictEqual(response.status, 400, 'duplicate image reorder was accepted');
    assert(!state.requests.some((entry) => entry.url.includes('/rpc/reorder_product_images_admin')),
      'duplicate reorder reached the mutation RPC');

    state.requests.length = 0;
    response = await request('PUT', `/api/admin/products/${PRODUCT_ID}/images/order`,
      JSON.stringify({ image_ids: [OTHER_IMAGE_ID] }),
      { ...auth, ...jsonHeaders });
    assert.strictEqual(response.status, 409, 'foreign image reorder was accepted');
    assert(!state.requests.some((entry) => entry.url.includes('/rpc/reorder_product_images_admin')),
      'foreign image reorder reached the mutation RPC');

    state.requests.length = 0;
    response = await request('PUT', `/api/admin/products/${PRODUCT_ID}/images/order`,
      JSON.stringify({ image_ids: [IMAGE_ID] }),
      { ...auth, ...jsonHeaders });
    assert.strictEqual(response.status, 200, 'valid reorder fixture failed');
    assert.strictEqual(
      state.requests.filter((entry) => entry.url.includes('/rpc/reorder_product_images_admin')).length,
      1,
      'reorder did not use exactly one atomic RPC'
    );
    assert(!state.requests.some((entry) => entry.method === 'PATCH'), 'reorder used an independent row PATCH');

    state.mode = 'protected_delete';
    state.requests.length = 0;
    response = await request('DELETE', `/api/admin/products/${PRODUCT_ID}`, null, auth);
    assert.strictEqual(response.status, 409, 'unsettled-order product protection was not preserved');
    assert.strictEqual(JSON.parse(response.body).error, 'product_has_unsettled_order');
    assert(!state.requests.some((entry) => entry.url.startsWith('/storage/v1/')),
      'Storage cleanup ran even though database deletion was blocked');

    console.log(`product-image-admin-test: ${checks.length} source controls + 14 mocked endpoint controls verified`);
    for (const name of checks) console.log(`  ✓ ${name}`);
  } catch (error) {
    if (childStderr) console.error(childStderr);
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await new Promise((resolve) => supabaseServer.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

endpointChecks().catch((error) => {
  console.error('product-image-admin-test FAIL', error);
  process.exit(1);
});

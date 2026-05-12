'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const PORT = 38482;

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opt = {
      hostname: '127.0.0.1',
      port: PORT,
      path: p,
      method,
      headers: { ...headers },
    };
    const req = http.request(opt, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject);
    if (body != null) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Content-Length', Buffer.byteLength(raw));
      req.write(raw);
    }
    req.end();
  });
}

async function waitForReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await request('GET', '/api/health');
      if (r.status === 200) return;
    } catch {
      /* */
    }
    await new Promise((res) => setTimeout(res, 80));
  }
  throw new Error('timeout');
}

async function main() {
  const dataDir = path.join(root, 'data', `test-${Date.now()}`);
  const fs = require('fs');
  fs.mkdirSync(dataDir, { recursive: true });
  const fakeHtml = path.join(dataDir, '.no-html');

  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      TICK_HTML: fakeHtml,
      TICK_ADMIN_PASSWORD: 'tick.2026',
      TICK_DB_PATH: path.join(dataDir, 't.sqlite'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForReady();
    const boot = await request('GET', '/api/public/bootstrap');
    if (boot.status !== 200) throw new Error('bootstrap ' + boot.status);
    const j = JSON.parse(boot.body);
    if (!Array.isArray(j.products) || j.products.length < 1) throw new Error('expected seeded products');

    const login = await request('POST', '/api/auth/login', { password: 'tick.2026' });
    const { token } = JSON.parse(login.body);

    const put = await request(
      'PUT',
      '/api/admin/kv/products',
      { value: j.products },
      { Authorization: 'Bearer ' + token }
    );
    if (put.status !== 200) throw new Error('put kv ' + put.status + put.body);

    const sync = await request(
      'POST',
      '/api/admin/sync',
      { products: j.products, settings: j.settings },
      { Authorization: 'Bearer ' + token }
    );
    if (sync.status !== 200) throw new Error('sync ' + sync.status);

    console.log('Stage 3 OK: bootstrap + admin kv', { products: j.products.length });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  }
}

main().catch((e) => {
  console.error('Stage 3 FAIL', e);
  process.exit(1);
});

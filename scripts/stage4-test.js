'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const PORT = 38483;
const dataDir = path.join(root, 'data', `stage4-${Date.now()}`);
const dbFile = path.join(dataDir, 't.sqlite');

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
  fs.mkdirSync(dataDir, { recursive: true });
  const fakeHtml = path.join(dataDir, '.no-html');

  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      TICK_HTML: fakeHtml,
      TICK_DB_PATH: dbFile,
      TICK_ADMIN_PASSWORD: 'tick.2026',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForReady();
    const order = {
      id: 'TKTEST01',
      items: [{ id: 1, name: 'Test', price: 100, qty: 1 }],
      total: 100,
      customer: { fn: 'A', ln: 'B', ph: '01001234567', email: 'a@b.co', area: 'Cairo', addr: 'x' },
      payment: 'COD',
      status: 'confirmed',
      date: Date.now(),
    };
    const o = await request('POST', '/api/public/order', { order });
    if (o.status !== 200) throw new Error('order ' + o.status + o.body);
    const nl = await request('POST', '/api/public/newsletter', { email: 'fan@example.com' });
    if (nl.status !== 200) throw new Error('newsletter ' + nl.status);
    const nl2 = await request('POST', '/api/public/newsletter', { email: 'not-an-email' });
    if (nl2.status !== 400) throw new Error('expected 400 invalid email');
    const n3 = await request('POST', '/api/public/notify', { productId: 1, phone: '0100' });
    if (n3.status !== 200) throw new Error('notify ' + n3.status);

    const login = await request('POST', '/api/auth/login', { password: 'tick.2026' });
    const { token } = JSON.parse(login.body);
    const orders = await request('GET', '/api/admin/kv/orders', null, { Authorization: 'Bearer ' + token });
    const arr = JSON.parse(orders.body).value;
    if (!Array.isArray(arr) || !arr.some((x) => x.id === 'TKTEST01')) throw new Error('order not in kv');

    console.log('Stage 4 OK: order + newsletter + notify');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  }
}

main().catch((e) => {
  console.error('Stage 4 FAIL', e);
  process.exit(1);
});

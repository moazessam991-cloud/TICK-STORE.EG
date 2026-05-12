'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const PORT = 38484;
const dataDir = path.join(root, 'data', `stage5-${Date.now()}`);
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
  for (let i = 0; i < 80; i++) {
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

    // Login admin
    const login = await request('POST', '/api/auth/login', { password: 'tick.2026' });
    if (login.status !== 200) throw new Error('login ' + login.status + ' ' + login.body);
    const { token } = JSON.parse(login.body);
    if (!token) throw new Error('missing token');

    // Place an order
    const order = {
      id: 'TKTEST05',
      items: [{ id: 1, name: 'Test', price: 100, qty: 1 }],
      total: 100,
      customer: { fn: 'A', ln: 'B', ph: '01001234567', email: 'a@b.co', area: 'Cairo', addr: 'x' },
      payment: 'COD',
      status: 'confirmed',
      date: Date.now(),
    };
    const o = await request('POST', '/api/public/order', { order });
    if (o.status !== 200) throw new Error('order ' + o.status + ' ' + o.body);

    // Admin bootstrap
    const boot = await request('GET', '/api/admin/bootstrap', null, { Authorization: 'Bearer ' + token });
    if (boot.status !== 200) throw new Error('bootstrap ' + boot.status + ' ' + boot.body);
    const d = JSON.parse(boot.body);

    if (!Array.isArray(d.orders)) throw new Error('orders missing/invalid');
    if (!d.orders.some((x) => x.id === 'TKTEST05')) throw new Error('order not found in bootstrap');

    if (!Array.isArray(d.customers)) throw new Error('customers missing/invalid');
    const cust = d.customers.find((c) => c.phone === '01001234567');
    if (!cust) throw new Error('customer not found in bootstrap');
    if ((cust.orders || 0) < 1) throw new Error('customer orders not updated');

    console.log('Stage 5 OK: /api/admin/bootstrap');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  }
}

main().catch((e) => {
  console.error('Stage 5 FAIL', e);
  process.exit(1);
});


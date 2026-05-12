'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const PORT = 38481;
const dbFile = path.join(root, 'data', `stage2-${Date.now()}.sqlite`);

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
  const fakeHtml = path.join(root, 'data', '.no-html');
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
    const bad = await request('POST', '/api/auth/login', { password: 'wrong' });
    if (bad.status !== 401) throw new Error('expected 401 bad password got ' + bad.status);
    const good = await request('POST', '/api/auth/login', { password: 'tick.2026' });
    if (good.status !== 200) throw new Error('login failed ' + good.status + ' ' + good.body);
    const { token } = JSON.parse(good.body);
    if (!token) throw new Error('no token');
    const me = await request('GET', '/api/auth/me', null, { Authorization: 'Bearer ' + token });
    if (me.status !== 200) throw new Error('me failed');
    const meNo = await request('GET', '/api/auth/me');
    if (meNo.status !== 401) throw new Error('me should 401');
    console.log('Stage 2 OK: auth + JWT');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  }
}

main().catch((e) => {
  console.error('Stage 2 FAIL', e);
  process.exit(1);
});

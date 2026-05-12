'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const PORT = 38485;
const dataDir = path.join(root, 'data', `stage6-${Date.now()}`);
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

    // Create a review (public)
    const r1 = await request('POST', '/api/public/review', {
      review: {
        productId: 1,
        stars: 5,
        name: 'Ahmed',
        text: 'Great watch quality and feels premium for the price.'
      }
    });
    if (r1.status !== 200) throw new Error('review post ' + r1.status + ' ' + r1.body);

    // Public bootstrap should include stored reviews
    const boot = await request('GET', '/api/public/bootstrap');
    if (boot.status !== 200) throw new Error('bootstrap ' + boot.status + ' ' + boot.body);
    const d = JSON.parse(boot.body);
    if (!d.reviews || typeof d.reviews !== 'object') throw new Error('reviews missing');
    const arr = d.reviews['1'];
    if (!Array.isArray(arr) || arr.length < 1) throw new Error('review not found in bootstrap');

    console.log('Stage 6 OK: /api/public/review + bootstrap reviews');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  }
}

main().catch((e) => {
  console.error('Stage 6 FAIL', e);
  process.exit(1);
});


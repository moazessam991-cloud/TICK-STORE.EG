'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const PORT = 38480;
const dbFile = path.join(root, 'data', `stage1-${Date.now()}.sqlite`);

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${p}`, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      })
      .on('error', reject);
  });
}

async function waitForReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await httpGet('/api/health');
      if (r.status === 200) return JSON.parse(r.body);
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 80));
  }
  throw new Error('server did not become ready');
}

async function main() {
  const fakeHtml = path.join(root, 'data', '.no-html');
  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), TICK_HTML: fakeHtml, TICK_DB_PATH: dbFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const health = await waitForReady();
    if (!health.ok) throw new Error('health not ok');
    console.log('Stage 1 OK:', health);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  }
}

main().catch((e) => {
  console.error('Stage 1 FAIL', e);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 38501;

function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    if (body !== undefined) {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      if (!req.getHeader('Content-Type')) req.setHeader('Content-Type', 'application/json');
      req.setHeader('Content-Length', raw.length);
      req.write(raw);
    }
    req.end();
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await request('GET', '/api/health');
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('preview test server did not start');
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-preview-security-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      TICK_HTML: path.join(dataDir, '.no-html'),
      TICK_DB_PATH: path.join(dataDir, 'test.sqlite'),
      TICK_ADMIN_PASSWORD: 'test-only-password',
      TICK_JWT_SECRET: 'test-only-jwt-secret-at-least-thirty-two-characters',
      TICK_STOREFRONT_ORIGINS: 'https://preview.example.com',
      SUPABASE_ANON_KEY: 'test-publishable-key-at-least-twenty-characters',
      SUPABASE_SERVICE_ROLE_KEY: '',
      TICK_INSTAPAY_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExitPromise = waitForExit(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForServer();
    let response = await request('GET', '/api/health');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(JSON.parse(response.body).status, 'alive');

    response = await request('GET', '/api/public/runtime-config');
    assert.strictEqual(response.status, 200);
    const runtimeConfig = JSON.parse(response.body);
    assert.strictEqual(runtimeConfig.supabase_publishable_key, 'test-publishable-key-at-least-twenty-characters');
    assert(!Object.prototype.hasOwnProperty.call(runtimeConfig, 'supabase_service_role_key'));

    response = await request('GET', '/api/ready');
    assert.strictEqual(response.status, 503, 'readiness must fail without Supabase while liveness remains healthy');
    assert.strictEqual(JSON.parse(response.body).status, 'not_ready');

    response = await request('GET', '/api/health', undefined, { Origin: 'https://attacker.example' });
    assert.notStrictEqual(response.headers['access-control-allow-origin'], 'https://attacker.example');

    response = await request('GET', '/api/health', undefined, { Origin: 'https://preview.example.com' });
    assert.strictEqual(response.headers['access-control-allow-origin'], 'https://preview.example.com');

    response = await request('POST', '/api/public/order', { order: {} });
    assert.strictEqual(response.status, 410);
    assert.strictEqual(JSON.parse(response.body).error, 'legacy_order_route_disabled');

    response = await request('POST', '/api/public/order', Buffer.alloc(140 * 1024, 0x20));
    assert.strictEqual(response.status, 413);
    assert.strictEqual(JSON.parse(response.body).error, 'request_body_too_large');

    response = await request('POST', '/api/admin/episodes', {});
    assert.strictEqual(response.status, 401);
    response = await request('PUT', '/api/admin/settings', { settings: { cod: true } });
    assert.strictEqual(response.status, 401);

    response = await request('POST', '/api/auth/login', { password: 'test-only-password' });
    assert.strictEqual(response.status, 200);
    const token = JSON.parse(response.body).token;
    response = await request('GET', '/api/auth/me', undefined, { Authorization: `Bearer ${token}` });
    assert.strictEqual(response.status, 200);
  } finally {
    child.kill('SIGTERM');
    await childExitPromise;
  }
  assert(!stderr.includes('test-only-password'), 'credential leaked to stderr');

  const missingProduction = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { PATH: process.env.PATH || '', NODE_ENV: 'production', PORT: '38502' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const missingExitPromise = waitForExit(missingProduction);
  let missingError = '';
  missingProduction.stderr.on('data', (chunk) => { missingError += chunk.toString(); });
  const missingExit = await missingExitPromise;
  assert.notStrictEqual(missingExit.code, 0, 'production started without critical secrets');
  assert(missingError.includes('TICK_ADMIN_PASSWORD_HASH'));

  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync('valid-password', salt, 64);
  const encodedHash = `scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`;
  const missingSupabaseUrl = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      PATH: process.env.PATH || '',
      NODE_ENV: 'production',
      PORT: '38503',
      TICK_ADMIN_PASSWORD_HASH: encodedHash,
      TICK_JWT_SECRET: 'production-jwt-secret-at-least-thirty-two-characters',
      TICK_STOREFRONT_ORIGINS: 'https://preview.example.com',
      TICK_DB_PATH: path.join(dataDir, 'production.sqlite'),
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      TICK_INSTAPAY_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const missingSupabaseUrlExitPromise = waitForExit(missingSupabaseUrl);
  let missingSupabaseUrlError = '';
  missingSupabaseUrl.stderr.on('data', (chunk) => { missingSupabaseUrlError += chunk.toString(); });
  const missingSupabaseUrlExit = await missingSupabaseUrlExitPromise;
  assert.notStrictEqual(missingSupabaseUrlExit.code, 0, 'production accepted a missing Supabase URL');
  assert(missingSupabaseUrlError.includes('Missing required production variable: SUPABASE_URL'));

  const plaintextProduction = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      PATH: process.env.PATH || '',
      NODE_ENV: 'production',
      PORT: '38504',
      TICK_ADMIN_PASSWORD_HASH: encodedHash,
      TICK_ADMIN_PASSWORD: 'must-not-be-accepted',
      TICK_JWT_SECRET: 'production-jwt-secret-at-least-thirty-two-characters',
      TICK_STOREFRONT_ORIGINS: 'https://preview.example.com',
      TICK_DB_PATH: path.join(dataDir, 'production.sqlite'),
      SUPABASE_URL: 'https://project.example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      TICK_INSTAPAY_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const plaintextExitPromise = waitForExit(plaintextProduction);
  let plaintextError = '';
  plaintextProduction.stderr.on('data', (chunk) => { plaintextError += chunk.toString(); });
  const plaintextExit = await plaintextExitPromise;
  assert.notStrictEqual(plaintextExit.code, 0, 'production accepted a plaintext admin credential');
  assert(plaintextError.includes('Plaintext or legacy admin credentials are not allowed'));

  console.log('preview-server-security-test: CORS, limits, auth, liveness/readiness, and fail-closed startup passed');
}

main().catch((error) => {
  console.error('preview-server-security-test failed:', error);
  process.exit(1);
});

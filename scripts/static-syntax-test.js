#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const javascriptFiles = [
  'server/index.js',
  'server/database.js',
  'server/defaults.js',
  'server/twilioWhatsApp.js',
  'public/supabase-client.js',
  'scripts/audit-business-logic-test.js',
  'scripts/instapay-flow-test.js',
  'scripts/order-status-cancellation-test.js',
  'scripts/product-image-admin-test.js',
  'scripts/phase1-verifier-test.js',
];

for (const file of javascriptFiles) {
  childProcess.execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' });
}

const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((source) => source.trim());
assert(inlineScripts.length > 0, 'no inline application script found');
for (const source of inlineScripts) new Function(source);

console.log(`static-syntax-test: ${javascriptFiles.length} JavaScript files and ${inlineScripts.length} inline blocks passed`);

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const server = read('server/index.js');
const client = read('public/supabase-client.js');
const html = read('public/index.html');
const migration = read('supabase/migrations/20260808010000_preview_security_hardening.sql');

for (const route of [
  "app.post('/api/admin/episodes', requireAuth",
  "app.patch('/api/admin/episodes/:id', requireAuth",
  "app.delete('/api/admin/episodes/:id', requireAuth",
  "app.put('/api/admin/settings', requireAuth",
]) assert(server.includes(route), `missing protected route: ${route}`);

assert(client.includes("'/api/admin/episodes/' + encodeURIComponent(id)"));
assert(client.includes("fetch('/api/admin/settings'"));
assert(client.includes("fetch('/api/public/runtime-config'"));
assert(!client.includes('baojwaqmriuxcnztixmr.supabase.co'), 'browser remains pinned to a specific Supabase project');
assert(!client.includes('sb_publishable_mNK6WYCml8BeBiO5GcKtmw_jNgklhdi'), 'browser remains pinned to a specific publishable key');
assert(!/function sbSaveEpisode[\s\S]{0,500}\.from\(['"]episodes['"]\)/.test(client), 'episodes still mutate directly from browser');
assert(!/function sbSaveSetting[\s\S]{0,600}\.from\(['"]settings['"]\)/.test(client), 'settings still mutate directly from browser');
assert(html.includes('S.settings={...DEFAULT_SETTINGS,...sett.data}'), 'sparse public settings do not merge with defaults');
assert(server.includes('const ADMIN_SETTING_KEYS = new Set'));
assert(server.includes("return { error: 'unsupported_setting_key' }"));
assert(server.includes("normalized === '' || /^\\+?[0-9 ()-]{8,24}$/.test(normalized)"), 'blank optional WhatsApp setting is rejected');
assert(server.includes('encoded.length <= 20000'));
assert(server.includes(".upsert(rows, { onConflict: 'key' })"), 'related settings are not saved in one statement');
assert(migration.includes('revoke all on table public.settings from public, anon, authenticated'));
assert(migration.includes("to_regclass('public.profiles') is not null"));
assert(migration.includes('alter table public.profiles force row level security'));
assert(migration.includes('revoke all on table public.profiles from public, anon, authenticated'));
assert(migration.includes("p.proname in ('is_admin', 'handle_new_user')"));
assert(migration.includes('revoke all on function %s from public, anon, authenticated'));
assert(html.includes("if(!['cod','instapay'].includes(k))return"));
assert(!html.includes('0% Installments (BNPL)'));
assert(!html.includes('Valu (BNPL)'));
assert(!html.includes('Sympl (BNPL)'));
assert(!html.includes('id="po-visa"'));
assert(!html.includes('Import Backup (JSON)'), 'local-only import control remains visible');
assert(!html.includes('Reset Operational Data'), 'local-only reset control remains visible');
for (const unsupportedClaim of [
  '0% installments',
  'Free delivery in Cairo',
  '14-day easy returns',
  'Trusted by 4,200',
  '30-day warranty',
  'Authenticated by TICK.',
  'fast Cairo delivery',
]) assert(!html.includes(unsupportedClaim), `unsupported customer claim remains: ${unsupportedClaim}`);
assert(server.includes("'emoji', 'bg_color', 'tags', 'size', 'video_url', 'model_3d_url', 'is_active'"));
assert(server.includes("return { error: 'unsupported_product_field' }"));

console.log('admin-content-settings-test: JWT persistence, allowlists, default merge, and preview controls passed');

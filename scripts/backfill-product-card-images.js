#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
if (typeof global.WebSocket === 'undefined') global.WebSocket = WebSocket;

const {
  createProductCardImage,
  deriveProductCardPath,
  isSafeProductImagePath,
} = require('../server/productImageCards');

const PRODUCT_IMAGE_BUCKET = 'product-images';
const PAGE_SIZE = 1000;

function parseOptions(argv) {
  let apply = false;
  let limit = Infinity;
  for (const argument of argv) {
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument.startsWith('--limit=')) {
      limit = Number(argument.slice('--limit='.length));
      if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid_limit');
      continue;
    }
    throw new Error(`unknown_option:${argument}`);
  }
  return { apply, limit };
}

async function fetchProductImageRows(client) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('product_images')
      .select('id, product_id, storage_path')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function cardObjectExists(bucket, cardPath) {
  const slash = cardPath.lastIndexOf('/');
  const folder = cardPath.slice(0, slash);
  const filename = cardPath.slice(slash + 1);
  const { data, error } = await bucket.list(folder, {
    limit: 100,
    search: filename,
  });
  if (error) throw error;
  return (data || []).some((entry) => entry && entry.name === filename);
}

async function downloadedBuffer(bucket, storagePath) {
  const { data, error } = await bucket.download(storagePath);
  if (error || !data) throw error || new Error('empty_product_image_download');
  if (Buffer.isBuffer(data)) return data;
  if (typeof data.arrayBuffer !== 'function') throw new Error('invalid_product_image_download');
  return Buffer.from(await data.arrayBuffer());
}

async function backfillProductCardImages({ client, rows, apply = false, limit = Infinity, logger = console }) {
  const bucket = client.storage.from(PRODUCT_IMAGE_BUCKET);
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    malformed: 0,
    existing: 0,
    planned: 0,
    uploaded: 0,
    failed: 0,
    limited: false,
  };

  for (const row of rows) {
    summary.scanned += 1;
    const productId = String(row && row.product_id || '');
    const storagePath = row && row.storage_path;
    if (!isSafeProductImagePath(storagePath, productId)) {
      summary.malformed += 1;
      logger.warn(`skip malformed product image row ${String(row && row.id || 'unknown')}`);
      continue;
    }

    const cardPath = deriveProductCardPath(storagePath, productId);
    try {
      if (await cardObjectExists(bucket, cardPath)) {
        summary.existing += 1;
        continue;
      }
      if (summary.planned >= limit) {
        summary.limited = true;
        break;
      }
      summary.planned += 1;
      if (!apply) continue;

      const original = await downloadedBuffer(bucket, storagePath);
      const card = await createProductCardImage(original);
      const { error } = await bucket.upload(cardPath, card, {
        contentType: 'image/webp',
        cacheControl: '31536000',
        upsert: false,
      });
      if (error) throw error;
      summary.uploaded += 1;
    } catch (error) {
      summary.failed += 1;
      const code = error && (error.code || error.name || error.statusCode) || 'unknown';
      logger.warn(`card backfill failed for image ${String(row.id || 'unknown')} (${String(code).slice(0, 80)})`);
    }
  }

  return summary;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceRoleKey) throw new Error('missing_supabase_service_configuration');

  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rows = await fetchProductImageRows(client);
  const summary = await backfillProductCardImages({ client, rows, ...options });
  console.log(JSON.stringify(summary));
  if (summary.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    const code = error && (error.code || error.message || error.name) || 'unknown';
    console.error(`product card backfill failed (${String(code).slice(0, 120)})`);
    process.exitCode = 1;
  });
}

module.exports = {
  backfillProductCardImages,
  cardObjectExists,
  fetchProductImageRows,
  parseOptions,
};

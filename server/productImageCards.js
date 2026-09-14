'use strict';

const sharp = require('sharp');

const PRODUCT_CARD_MAX_WIDTH = 720;
const PRODUCT_CARD_MAX_HEIGHT = 900;
const PRODUCT_CARD_WEBP_QUALITY = 80;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSafeProductImagePath(storagePath, productId) {
  if (typeof storagePath !== 'string' || storagePath.length > 500) return false;
  if (typeof productId !== 'string' || !UUID_PATTERN.test(productId)) return false;
  if (storagePath.includes('..') || storagePath.includes('\\')) return false;
  const escapedProductId = productId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^${escapedProductId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp)$`,
    'i'
  ).test(storagePath);
}

function deriveProductCardPath(storagePath, productId) {
  if (!isSafeProductImagePath(storagePath, productId)) {
    throw new Error('unsafe_product_image_path');
  }
  const filename = storagePath.slice(productId.length + 1);
  const objectId = filename.slice(0, filename.lastIndexOf('.'));
  return `${productId}/cards/${objectId}.webp`;
}

async function createProductCardImage(input) {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new Error('invalid_product_image_buffer');
  }
  return sharp(input)
    .rotate()
    .resize({
      width: PRODUCT_CARD_MAX_WIDTH,
      height: PRODUCT_CARD_MAX_HEIGHT,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: PRODUCT_CARD_WEBP_QUALITY })
    .toBuffer();
}

module.exports = {
  PRODUCT_CARD_MAX_WIDTH,
  PRODUCT_CARD_MAX_HEIGHT,
  PRODUCT_CARD_WEBP_QUALITY,
  createProductCardImage,
  deriveProductCardPath,
  isSafeProductImagePath,
};

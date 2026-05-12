'use strict';

const fs = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, 'seed-data.json');

function loadSeed() {
  try {
    const raw = fs.readFileSync(SEED_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      products: [],
      archive: [],
      straps: [],
      episodes: [],
      settings: {
        bnpl: true,
        cod: true,
        freeShip: true,
        maintenance: false,
        waNum: '+20 100 000 0000',
        dropDay: 'Monday',
        dropTime: '10:00',
        currency: 'EGP',
        storeName: 'TICK.',
        storeEmail: 'hello@tick.eg',
        socials: {},
      },
    };
  }
}

function seedIfEmpty(db, api) {
  const d = loadSeed();
  if (!api.getJson(db, 'products')?.length) api.setJson(db, 'products', d.products);
  if (!api.getJson(db, 'archive')?.length) api.setJson(db, 'archive', d.archive);
  if (!api.getJson(db, 'straps')?.length) api.setJson(db, 'straps', d.straps);
  if (!api.getJson(db, 'episodes')?.length) api.setJson(db, 'episodes', d.episodes);
  if (!api.getJson(db, 'settings')) api.setJson(db, 'settings', d.settings);
  if (!api.getJson(db, 'orders')) api.setJson(db, 'orders', []);
  if (!api.getJson(db, 'customers')) api.setJson(db, 'customers', []);
  if (!api.getJson(db, 'subscribers')) api.setJson(db, 'subscribers', []);
  if (!api.getJson(db, 'drops')) api.setJson(db, 'drops', []);
  if (!api.getJson(db, 'audit')) api.setJson(db, 'audit', []);
  if (!api.getJson(db, 'reviews')) api.setJson(db, 'reviews', {});
  if (!api.getJson(db, 'notify_me')) api.setJson(db, 'notify_me', []);
}

module.exports = { seedIfEmpty, loadSeed, SEED_PATH };

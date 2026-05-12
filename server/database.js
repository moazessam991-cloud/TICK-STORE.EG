'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');

function getDbPath() {
  if (process.env.TICK_DB_PATH) return path.resolve(process.env.TICK_DB_PATH);
  return path.join(DATA_DIR, 'tick.sqlite');
}

function openDb() {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
  `);
  return db;
}

const KEYS = [
  'products',
  'archive',
  'straps',
  'episodes',
  'settings',
  'orders',
  'customers',
  'subscribers',
  'drops',
  'audit',
  'reviews',
  'notify_me',
];

function getJson(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function setJson(db, key, value) {
  const now = Date.now();
  const json = JSON.stringify(value);
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, json, now);
}

function appendOrder(db, order) {
  if (!order || !order.id) throw new Error('order.id required');
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, payload, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`
  ).run(order.id, JSON.stringify(order), order.date || now);
}

function listOrders(db, limit = 500) {
  return db
    .prepare('SELECT payload FROM orders ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map((r) => JSON.parse(r.payload));
}

module.exports = {
  DATA_DIR,
  getDbPath,
  openDb,
  KEYS,
  getJson,
  setJson,
  appendOrder,
  listOrders,
};

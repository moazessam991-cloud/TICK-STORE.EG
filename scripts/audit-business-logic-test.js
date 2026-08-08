'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'create-order', 'index.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260721010000_order_integrity.sql'),
  'utf8'
);

const start = html.indexOf('// AUDIT_BUSINESS_LOGIC_START');
const end = html.indexOf('// AUDIT_BUSINESS_LOGIC_END');
assert(start >= 0 && end > start, 'business logic test block is missing');

const context = {
  Intl,
  Date,
  Math,
  Number,
  String,
  Object,
  Array,
  prodCatSlug(product) {
    return product && product.category_slug || '';
  },
};
vm.createContext(context);
vm.runInContext(
  html.slice(start, end) +
    '\nthis.auditExports={finiteAmount,moneyAmount,productDisplayPrice,orderCountsAsRevenue,cairoDateParts,productStockState,categoryPercentages,dashboardMetrics};',
  context
);

const { dashboardMetrics, productDisplayPrice } = context.auditExports;
const now = Date.parse('2026-07-21T00:30:00+03:00');
const orders = [
  {
    id: 'current',
    status: 'pending',
    total: '100',
    date: Date.parse('2026-07-20T22:00:00Z'),
    customer: { area: 'Cairo' },
    items: [{ pid: 'dress-product', price: '30', qty: 2 }],
  },
  {
    id: 'cancelled',
    status: 'cancelled',
    total: 50,
    date: Date.parse('2026-07-20T22:05:00Z'),
    customer: { area: 'Cairo' },
    items: [{ pid: 'sport-product', price: 50, qty: 1 }],
  },
  {
    id: 'prior-year',
    status: 'delivered',
    total: 200,
    date: Date.parse('2025-07-21T09:00:00Z'),
    customer: { area: 'Giza' },
    items: [{ pid: 'deleted-product', category_slug: 'limited-edition', price: 200, qty: 1 }],
  },
];
const products = [
  { id: 'dress-product', category_slug: 'dress', stock_quantity: 5 },
  { id: 'sport-product', category_slug: 'sport', stock_quantity: 6 },
  { id: 'forced', force_out_of_stock: true, stock_quantity: 10 },
  { id: 'zero', stock_quantity: 0 },
  { id: 'negative', stock_quantity: -1 },
];

const metrics = dashboardMetrics(orders, products, now);
assert.strictEqual(metrics.totalRevenue, 300, 'cancelled revenue must be excluded and strings coerced');
assert.strictEqual(metrics.todayOrders.length, 2, 'Cairo-day order count is wrong');
assert.strictEqual(metrics.todayRevenue, 100, 'Cairo-day revenue is wrong');
assert.strictEqual(metrics.byMonth[6], 100, 'monthly chart must include only the current Cairo year');
assert.strictEqual(metrics.averageOrderValue, 150, 'average must use revenue-eligible orders');
assert.strictEqual(metrics.categoryRevenue.dress, 60, 'category line totals are wrong');
assert.strictEqual(metrics.categoryRevenue.other, 240, 'unknown products and missing item revenue must reconcile to Other');
assert.strictEqual(
  Object.values(metrics.categoryRevenue).reduce((sum, value) => sum + value, 0),
  metrics.totalRevenue,
  'category revenue must reconcile to canonical order revenue'
);
assert.strictEqual(
  Object.values(metrics.categoryPercentages).reduce((sum, value) => sum + value, 0),
  100,
  'non-empty category percentages must total exactly 100'
);
assert.strictEqual(metrics.lowStock.length, 1, 'low stock must mean 1 through 5 and exclude out-of-stock');
assert.strictEqual(metrics.outOfStock.length, 3, 'manual, zero and negative stock must all be out-of-stock');
assert.strictEqual(productDisplayPrice({ price: 100, sale_price: 80 }), 80, 'valid sale price must be used');
assert.strictEqual(productDisplayPrice({ price: 100, sale_price: null }), 100, 'null sale price must use regular price');
assert.strictEqual(productDisplayPrice({ price: 100, sale_price: -10 }), 100, 'negative sale price must be rejected');
assert.strictEqual(productDisplayPrice({ price: 100, sale_price: 120 }), 100, 'sale price above regular price must be rejected');
assert.strictEqual(context.auditExports.moneyAmount(10.1 * 3), 30.3, 'money calculations must round to two decimals');

assert(server.includes("fetchAllSupabaseRows(() => sbAdmin\n        .from('orders')"), 'admin orders must use service-role pagination');
assert(!server.includes(".limit(1000)"), 'admin order history must not be truncated at 1,000');
assert(html.includes('await sbRestockProduct(id,qty)'), 'restock must persist through the authenticated API');
assert(!html.includes("const oid='TK'+Date.now()"), 'confirmation must not manufacture an order ID');
assert(!html.includes('if(d.orders)S.orders=d.orders'), 'backup import must not replace canonical orders');
assert(!html.includes('S.orders=[]'), 'reset must not clear visible orders');
assert(html.includes("else if(p.startsWith('/admin')){if(getSession())__tickRenderAdminFromApi()"), 'admin reload must refresh canonical orders');
assert(!server.match(/\.from\(['"]orders['"]\)[\s\S]{0,120}\.delete\(/), 'server must not delete orders');
assert(server.includes("sbAdmin.rpc('update_order_fulfillment_status'"), 'status changes must use the locked database transition');
assert(edge.includes('create_preview_order_with_stock'), 'Edge Function must use the preview wrapper around the atomic stock RPC');
assert(!edge.match(/\.from\(["']orders["']\)[\s\S]{0,120}\.insert\(/), 'Edge Function must not insert orders outside the RPC');
assert(migration.includes('pg_advisory_xact_lock'), 'RPC must serialize idempotent retries');
assert(migration.includes('product.sale_price < product.price'), 'RPC must validate sale prices');
assert(migration.includes("message = 'order_total_changed'"), 'RPC must reject a stale displayed checkout total');
assert(migration.includes('), 2), 0)'), 'RPC total must round currency to two decimals');
assert(migration.includes('product.force_out_of_stock is true'), 'RPC must enforce manual out-of-stock');
assert(migration.includes('drop policy if exists orders_select_anon'), 'anonymous order reads must be removed');
assert(migration.includes('drop policy if exists orders_update_anon'), 'anonymous order updates must be removed');
assert(migration.includes('drop policy if exists order_items_select_anon'), 'anonymous order-item reads must be removed');
assert(!migration.includes('create policy "Authenticated users can create own orders."'), 'orders must only be created through the atomic service-role RPC');
assert(html.includes('product_id: pid'), 'notify-me inserts must use the real product_id column');

console.log('Audit business logic OK');

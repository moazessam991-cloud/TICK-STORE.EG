/* ═══════════════════════════════════════════════════
   SUPABASE INTEGRATION
   Exposes window.sbClient (the initialized Supabase client)
   and window.initSupabase() for bootstrapping.
   Never uses the name "supabase" for the client to avoid
   colliding with window.supabase set by the CDN bundle.
═══════════════════════════════════════════════════ */
const SUPABASE_CONFIG = {
  url: 'https://baojwaqmriuxcnztixmr.supabase.co',
  anonKey: 'sb_publishable_mNK6WYCml8BeBiO5GcKtmw_jNgklhdi'
};

// The initialized client lives here — accessed as window.sbClient from any script.
// We do NOT name it "supabase" because the CDN bundle sets window.supabase to the
// SDK namespace object, and we must not overwrite or shadow that.
window.sbClient = null;

function initSupabase() {
  // @supabase/supabase-js v2 CDN bundle exposes window.supabase with .createClient()
  const sdk = window.supabase;
  if (!sdk || typeof sdk.createClient !== 'function') {
    console.error('[Supabase] SDK not ready — make sure the CDN <script> runs before supabase-client.js');
    return;
  }
  window.sbClient = sdk.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
}

// ─── internal helper so we fail fast with a clear message ───
function _db() {
  if (!window.sbClient) throw new Error('[Supabase] Not initialised — call initSupabase() first');
  return window.sbClient;
}

// ─── AUTHENTICATION ───
async function sbSignUp(email, password, fullName) {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  const { data, error } = await _db().auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } }
  });
  return { data, error };
}

async function sbSignIn(email, password) {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  const { data, error } = await _db().auth.signInWithPassword({ email, password });
  return { data, error };
}

async function sbSignOut() {
  if (!window.sbClient) return { error: null };
  const { error } = await _db().auth.signOut();
  return { error };
}

async function sbGetUser() {
  if (!window.sbClient) return null;
  const { data: { user } } = await _db().auth.getUser();
  return user;
}
// ─── DATA FETCHING ───
async function sbGetProducts() {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  // Joins categories(*) so callers get real category data (name, slug, etc.)
  // via the relational FK instead of any old text-based category tag.
  // .order('position', {foreignTable:'product_images'}) preserves the admin's
  // chosen photo order (first photo = main image) instead of whatever order
  // Postgres happens to return rows in.
  const { data, error } = await _db()
    .from('products')
    .select('*, product_images(*), categories(*)')
    .eq('is_active', true)
    .order('position', { foreignTable: 'product_images', ascending: true });
  return { data, error };
}

async function sbGetCategories() {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  const { data, error } = await _db().from('categories').select('*');
  return { data, error };
}

async function sbGetArchive() {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  // 'products.cat' does not exist in the current schema. "Vintage/archive" is now
  // a row in `categories` (e.g. slug = 'vintage'), and products relate to it via
  // products.category_id -> categories.id. We filter through that relation
  // instead of a denormalized text field, and join categories(*) so the caller
  // still gets the category name/slug without a second round trip.
  const { data, error } = await _db()
    .from('products')
    .select('*, product_images(*), categories!inner(*)')
    .eq('categories.slug', 'vintage')
    .eq('is_active', true)
    .order('position', { foreignTable: 'product_images', ascending: true });
  return { data, error };
}

async function sbGetStrapProducts() {
  // Straps now live in `products` (category slug 'straps'), one row per strap
  // TYPE (NATO/Leather/Rubber/...), with per-color/width options in the
  // existing `variants` jsonb column. See TICK_CONTINUATION_PROMPT.md TODO D.
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  const { data, error } = await _db()
    .from('products')
    .select('*, product_images(*), categories!inner(*)')
    .eq('categories.slug', 'straps')
    .eq('is_active', true)
    .order('position', { foreignTable: 'product_images', ascending: true });
  return { data, error };
}

async function sbGetEpisodes() {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  const { data, error } = await _db().from('episodes').select('*').order('episode_number');
  return { data, error };
}

async function sbGetSettings() {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  const { data, error } = await _db().from('settings').select('*');
  return { data, error };
}

async function sbGetReviews(productId) {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  const { data, error } = await _db().from('reviews').select('*').eq('product_id', productId).order('created_at', { ascending: false });
  return { data, error };
}

// ─── SUBSCRIBERS (newsletter) — TODO A ───
// Requires the `subscribers` table (see the SQL handed to the user alongside
// this change). Customer-facing insert uses the anon key — RLS on this table
// must allow public INSERT — and treats "already subscribed" (unique
// violation, code 23505) as a soft success, not an error.
async function sbSubscribeEmail(email, source) {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  const { data, error } = await _db()
    .from('subscribers')
    .insert([{ email, source: source || 'newsletter' }])
    .select()
    .single();
  if (error && error.code === '23505') return { data: null, error: null, alreadySubscribed: true };
  return { data, error };
}

async function sbGetSubscribers() {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  const { data, error } = await _db().from('subscribers').select('*').order('subscribed_at', { ascending: false });
  return { data, error };
}

// ─── TRANSACTIONS ───
async function sbCreateOrder(orderData, items) {
  if (!window.sbClient) {
    return {
      data: null,
      error: new Error("Supabase not initialised"),
    };
  }

  const { data, error } = await _db().functions.invoke("create-order", {
    body: {
      orderData,
      items,
    },
  });

  if (error) {
    return {
      data: null,
      error,
    };
  }

  return {
    data: data.order,
    error: null,
  };
}
// ─── STORAGE ───
async function sbUploadImage(bucket, path, file) {
  if (!window.sbClient) return { publicUrl: null, error: new Error('Supabase not initialised') };
  const { data, error } = await _db().storage.from(bucket).upload(path, file);
  if (error) return { publicUrl: null, error };
  const { data: { publicUrl } } = _db().storage.from(bucket).getPublicUrl(data.path);
  return { publicUrl, error: null };
}

// ─── PRODUCT IMAGES (product_images table) — TODO B ───
// Bucket name assumed: 'product-images' (see SQL/setup notes handed to the
// user — the bucket and its RLS policies must be created before this works).
const PRODUCT_IMAGE_BUCKET = 'product-images';

async function sbGetProductImages(productId) {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  return await _db().from('product_images').select('*').eq('product_id', productId).order('position', { ascending: true });
}

// Uploads one file for a given product at a given display position and
// inserts the corresponding product_images row. Returns the inserted row
// (id, url, position, storage_path) so the caller can track it locally.
async function sbUploadProductImage(productId, file, position) {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  const safeName = (file.name || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = productId + '/' + Date.now() + '_' + position + '_' + safeName;
  const { publicUrl, error: upErr } = await sbUploadImage(PRODUCT_IMAGE_BUCKET, path, file);
  if (upErr) return { data: null, error: upErr };
  const { data, error } = await _db()
    .from('product_images')
    .insert([{ product_id: productId, url: publicUrl, position, storage_path: path }])
    .select()
    .single();
  return { data, error };
}

// Deletes both the Storage object (if storagePath is known) and the
// product_images row. Never throws — a missing/already-gone storage object
// should not block removing the DB row.
async function sbDeleteProductImage(imageId, storagePath) {
  if (!window.sbClient) return { error: new Error('Supabase not initialised') };
  if (storagePath) {
    try { await _db().storage.from(PRODUCT_IMAGE_BUCKET).remove([storagePath]); } catch (e) { console.warn('[Supabase] storage remove failed', e); }
  }
  const { error } = await _db().from('product_images').delete().eq('id', imageId);
  return { error };
}

async function sbSetProductImagePosition(imageId, position) {
  if (!window.sbClient) return { error: new Error('Supabase not initialised') };
  return await _db().from('product_images').update({ position }).eq('id', imageId);
}

// Deletes a product's images (Storage + rows) and then the product row
// itself. Used by delProd() so deleting a watch/archive/strap-type doesn't
// leave orphaned files in Storage or orphaned product_images rows behind.
async function sbDeleteProduct(productId) {
  if (!window.sbClient) return { error: new Error('Supabase not initialised') };
  try {
    const { data: imgs } = await _db().from('product_images').select('*').eq('product_id', productId);
    for (const row of (imgs || [])) {
      if (row.storage_path) { try { await _db().storage.from(PRODUCT_IMAGE_BUCKET).remove([row.storage_path]); } catch (e) {} }
    }
    if (imgs && imgs.length) await _db().from('product_images').delete().eq('product_id', productId);
  } catch (e) { console.warn('[Supabase] cleanup of product_images before delete failed', e); }
  const { error } = await _db().from('products').delete().eq('id', productId);
  return { error };
}

// ─── ADMIN CRUD ───
async function sbSaveProduct(product, isEdit) {
  if (!window.sbClient) {
    return { data: null, error: new Error('Supabase not initialised') };
  }

  if (isEdit) {
    return await _db()
      .from('products')
      .update(product)
      .eq('id', product.id)
      .select()
      .single();
  }

  return await _db()
    .from('products')
    .insert([product])
    .select()
    .single();
}

async function sbUpdateOrderStatus(orderId, status) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { data: null, error: new Error('Admin session is missing') };

  try {
    const response = await fetch('/api/admin/orders/' + encodeURIComponent(orderId) + '/status', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Order status update failed');
    return { data: payload.order, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

async function sbRestockProduct(productId, quantity) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { data: null, error: new Error('Admin session is missing') };

  try {
    const response = await fetch('/api/admin/products/' + encodeURIComponent(productId) + '/restock', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ quantity })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Product restock failed');
    return { data: payload.product, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

async function sbSaveEpisode(ep, isEdit) {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  if (isEdit) {
    return await _db().from('episodes').update(ep).eq('id', ep.id);
  } else {
    return await _db().from('episodes').insert([ep]);
  }
}

async function sbSaveSetting(key, value) {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  return await _db().from('settings').upsert({ key, value, updated_at: new Date().toISOString() });
}

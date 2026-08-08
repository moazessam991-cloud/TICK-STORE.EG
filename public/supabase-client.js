/* ═══════════════════════════════════════════════════
   SUPABASE INTEGRATION
   Exposes window.sbClient (the initialized Supabase client)
   and window.initSupabase() for bootstrapping.
   Never uses the name "supabase" for the client to avoid
   colliding with window.supabase set by the CDN bundle.
═══════════════════════════════════════════════════ */
// The initialized client lives here — accessed as window.sbClient from any script.
// We do NOT name it "supabase" because the CDN bundle sets window.supabase to the
// SDK namespace object, and we must not overwrite or shadow that.
window.sbClient = null;

async function initSupabase() {
  // @supabase/supabase-js v2 CDN bundle exposes window.supabase with .createClient()
  const sdk = window.supabase;
  if (!sdk || typeof sdk.createClient !== 'function') {
    console.error('[Supabase] SDK not ready — make sure the CDN <script> runs before supabase-client.js');
    return false;
  }
  try {
    const response = await fetch('/api/public/runtime-config', { cache: 'no-store' });
    const config = await response.json();
    if (!response.ok || typeof config.supabase_url !== 'string' || typeof config.supabase_publishable_key !== 'string') {
      throw new Error('invalid_runtime_config');
    }
    const parsedUrl = new URL(config.supabase_url);
    if (parsedUrl.protocol !== 'https:' || config.supabase_publishable_key.length < 20) {
      throw new Error('invalid_runtime_config');
    }
    window.sbClient = sdk.createClient(parsedUrl.toString(), config.supabase_publishable_key);
    return true;
  } catch (_error) {
    console.error('[Supabase] Runtime configuration is unavailable');
    return false;
  }
}

// ─── internal helper so we fail fast with a clear message ───
function _db() {
  if (!window.sbClient) throw new Error('[Supabase] Not initialised — call initSupabase() first');
  return window.sbClient;
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
  try {
    const response = await fetch('/api/public/settings', { cache: 'no-store' });
    const payload = await apiJson(response);
    return { data: payload.settings || {}, error: null };
  } catch (error) {
    return { data: null, error };
  }
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
    let payload = null;
    try {
      if (error.context && typeof error.context.json === 'function') {
        payload = await error.context.json();
      }
    } catch (_parseError) {}
    if (payload && payload.error) {
      const requestError = new Error(payload.error);
      requestError.code = payload.error;
      requestError.status = error.context && error.context.status;
      requestError.retryAfter = payload.retry_after_seconds || null;
      return { data: null, error: requestError };
    }
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

async function apiJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Request failed');
    error.code = payload.error || 'request_failed';
    error.status = response.status;
    error.order = payload.order || null;
    error.cleanupFailed = payload.cleanup_failed === true;
    error.imageDeleted = payload.image_deleted === true;
    error.productDeleted = payload.product_deleted === true;
    throw error;
  }
  return payload;
}

async function sbGetInstapayOrder(orderId, accessToken) {
  try {
    const response = await fetch(
      '/api/public/instapay/orders/' + encodeURIComponent(orderId) + '/status',
      {
        method: 'GET',
        headers: { 'X-Payment-Access-Token': accessToken },
        cache: 'no-store'
      }
    );
    const payload = await apiJson(response);
    return { data: payload.order, payment: payload.payment || null, error: null };
  } catch (error) {
    return { data: error.order || null, payment: null, error };
  }
}

async function sbSubmitInstapayProof(orderId, accessToken, reference, senderName, file) {
  try {
    const response = await fetch(
      '/api/public/instapay/orders/' + encodeURIComponent(orderId) + '/proof',
      {
        method: 'POST',
        headers: {
          'Content-Type': file.type,
          'X-Payment-Access-Token': accessToken,
          'X-Payment-Reference': encodeURIComponent(reference),
          'X-Payment-Sender-Name': encodeURIComponent(senderName)
        },
        body: file
      }
    );
    const payload = await apiJson(response);
    return { data: payload.order, error: null };
  } catch (error) {
    return { data: error.order || null, error };
  }
}
// ─── PRODUCT IMAGES ───
// Public image rows/URLs remain readable. Every mutation goes through the
// Express Admin JWT API; the browser never receives or submits Storage paths.

async function sbGetProductImages(productId) {
  if (!window.sbClient) return { data: null, error: new Error('Supabase not initialised') };
  return await _db()
    .from('product_images')
    .select('id, product_id, url, position, created_at')
    .eq('product_id', productId)
    .order('position', { ascending: true });
}

async function sbUploadProductImage(productId, file) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { data: null, error: new Error('Admin session is missing') };

  try {
    const response = await fetch(
      '/api/admin/products/' + encodeURIComponent(String(productId)) + '/images',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': file.type,
        },
        body: file,
      }
    );
    const payload = await apiJson(response);
    return { data: payload.image, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

async function sbDeleteProductImage(imageId) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { data: null, error: new Error('Admin session is missing') };

  try {
    const response = await fetch(
      '/api/admin/product-images/' + encodeURIComponent(String(imageId)),
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      }
    );
    const payload = await apiJson(response);
    return { data: payload, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

async function sbReorderProductImages(productId, imageIds) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { data: null, error: new Error('Admin session is missing') };

  try {
    const response = await fetch(
      '/api/admin/products/' + encodeURIComponent(String(productId)) + '/images/order',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image_ids: imageIds }),
      }
    );
    const payload = await apiJson(response);
    return { data: payload.images, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

async function sbDeleteProduct(productId) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { data: null, error: new Error('Admin session is missing') };

  try {
    const response = await fetch(
      '/api/admin/products/' + encodeURIComponent(String(productId)),
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      }
    );
    const payload = await apiJson(response);
    return { data: payload, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

// ─── ADMIN CRUD ───
async function sbSaveProduct(product, isEdit) {
  const token = sessionStorage.getItem('tick_api_token');

  if (!token) {
    return {
      data: null,
      error: new Error('Admin session is missing'),
    };
  }

  try {
    const productId =
      product && product.id ? String(product.id) : '';

    const url = isEdit
      ? '/api/admin/products/' + encodeURIComponent(productId)
      : '/api/admin/products';

    const payload = { ...product };
    delete payload.id;

    const response = await fetch(url, {
      method: isEdit ? 'PATCH' : 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result = await apiJson(response);

    if (!response.ok) {
      throw new Error(result.error || 'Product save failed');
    }

    return {
      data: result.product,
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error,
    };
  }
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
    const payload = await apiJson(response);
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

async function sbAdminInstapayAction(orderId, action, body) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { data: null, error: new Error('Admin session is missing') };

  try {
    const response = await fetch(
      '/api/admin/orders/' + encodeURIComponent(orderId) + '/instapay/' + action,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body || {})
      }
    );
    const payload = await apiJson(response);
    return { data: payload.order, error: null };
  } catch (error) {
    return { data: error.order || null, error };
  }
}

async function sbConfirmInstapayPayment(orderId) {
  return sbAdminInstapayAction(orderId, 'confirm', {});
}

async function sbRejectInstapayPayment(orderId, reason) {
  return sbAdminInstapayAction(orderId, 'reject', { reason });
}

async function sbGetInstapayProofUrl(orderId) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { url: null, error: new Error('Admin session is missing') };

  try {
    const response = await fetch(
      '/api/admin/orders/' + encodeURIComponent(orderId) + '/instapay/proof',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token },
        cache: 'no-store'
      }
    );
    const payload = await apiJson(response);
    return { url: payload.url, error: null };
  } catch (error) {
    return { url: null, error };
  }
}

async function sbSaveEpisode(ep, isEdit) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { data: null, error: new Error('Admin session is missing') };
  try {
    const id = ep && ep.id ? String(ep.id) : '';
    const body = { ...ep };
    delete body.id;
    const response = await fetch(
      isEdit ? '/api/admin/episodes/' + encodeURIComponent(id) : '/api/admin/episodes',
      {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const payload = await apiJson(response);
    return { data: payload.episode, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

async function sbDeleteEpisode(id) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { data: null, error: new Error('Admin session is missing') };
  try {
    const response = await fetch('/api/admin/episodes/' + encodeURIComponent(String(id)), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    });
    const payload = await apiJson(response);
    return { data: payload, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

async function sbSaveSettings(settings) {
  const token = sessionStorage.getItem('tick_api_token');
  if (!token) return { data: null, error: new Error('Admin session is missing') };
  try {
    const response = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    const payload = await apiJson(response);
    return { data: payload.settings || [], error: null };
  } catch (error) {
    return { data: null, error };
  }
}
async function sbSaveSetting(key, value) {
  const token = sessionStorage.getItem('tick_api_token');

  if (!token) {
    return {
      data: null,
      error: new Error('Admin session is missing'),
    };
  }

  try {
    const response = await fetch(
      '/api/admin/settings/' + encodeURIComponent(String(key)),
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value }),
      }
    );

    const payload = await apiJson(response);

    if (!response.ok) {
      throw new Error(payload.error || 'Setting save failed');
    }

    return {
      data: Array.isArray(payload.settings) ? payload.settings[0] : null,
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error,
    };
  }
}

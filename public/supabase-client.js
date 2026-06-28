/* ═══════════════════════════════════════════════════
   SUPABASE INTEGRATION
═══════════════════════════════════════════════════ */
const SUPABASE_CONFIG = {
  url: 'YOUR_SUPABASE_URL',
  anonKey: 'YOUR_SUPABASE_ANON_KEY'
};

let supabase = null;

function initSupabase() {
  if (typeof supabasejs === 'undefined') {
    console.error('Supabase SDK not loaded');
    return;
  }
  supabase = supabasejs.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
}

// ─── AUTHENTICATION ───
async function sbSignUp(email, password, fullName) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } }
  });
  return { data, error };
}

async function sbSignIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { data, error };
}

async function sbSignOut() {
  const { error } = await supabase.auth.signOut();
  return { error };
}

async function sbGetUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// ─── DATA FETCHING ───
async function sbGetProducts() {
  const { data, error } = await supabase
    .from('products')
    .select(`*, product_images(*)`)
    .eq('is_active', true);
  return { data, error };
}

async function sbGetCategories() {
  const { data, error } = await supabase.from('categories').select('*');
  return { data, error };
}

async function sbGetArchive() {
  const { data, error } = await supabase.from('products').select('*').eq('cat', 'vintage');
  return { data, error };
}

async function sbGetStraps() {
  const { data, error } = await supabase.from('straps').select('*');
  return { data, error };
}

async function sbGetEpisodes() {
  const { data, error } = await supabase.from('episodes').select('*').order('episode_number');
  return { data, error };
}

async function sbGetReviews(productId) {
  const { data, error } = await supabase.from('reviews').select('*').eq('product_id', productId);
  return { data, error };
}

// ─── TRANSACTIONS ───
async function sbCreateOrder(orderData, items) {
  const user = await sbGetUser();
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert([{
      user_id: user?.id,
      total_amount: orderData.total,
      payment_method: orderData.payment,
      customer_name: orderData.customer.fn + ' ' + orderData.customer.ln,
      customer_phone: orderData.customer.ph,
      customer_email: orderData.customer.email,
      shipping_address: orderData.customer,
      notes: orderData.notes
    }])
    .select()
    .single();

  if (orderErr) return { error: orderErr };

  const orderItems = items.map(it => ({
    order_id: order.id,
    product_id: it.pid,
    quantity: it.qty,
    price_at_purchase: it.price,
    metadata: it.metadata
  }));

  const { error: itemsErr } = await supabase.from('order_items').insert(orderItems);
  return { data: order, error: itemsErr };
}

// ─── STORAGE ───
async function sbUploadImage(bucket, path, file) {
  const { data, error } = await supabase.storage.from(bucket).upload(path, file);
  if (error) return { error };
  const { data: { publicUrl } } = supabase.storage.from(bucket).getPublicUrl(data.path);
  return { publicUrl };
}

// ─── ADMIN CRUD ───
async function sbSaveProduct(product, isEdit) {
  if (isEdit) {
    return await supabase.from('products').update(product).eq('id', product.id);
  } else {
    return await supabase.from('products').insert([product]);
  }
}

async function sbUpdateOrderStatus(orderId, status) {
  return await supabase.from('orders').update({ status }).eq('id', orderId);
}

async function sbSaveStrap(strap, isEdit) {
  if (isEdit) {
    return await supabase.from('straps').update(strap).eq('id', strap.id);
  } else {
    return await supabase.from('straps').insert([strap]);
  }
}

async function sbSaveEpisode(ep, isEdit) {
  if (isEdit) {
    return await supabase.from('episodes').update(ep).eq('id', ep.id);
  } else {
    return await supabase.from('episodes').insert([ep]);
  }
}

async function sbSaveSetting(key, value) {
  return await supabase.from('settings').upsert({ key, value, updated_at: new Date().toISOString() });
}

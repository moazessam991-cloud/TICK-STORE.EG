-- Fresh-install active schema baseline.
--
-- This block is intentionally part of the already-versioned first migration:
-- new projects need these relations before the order-integrity ALTERs and
-- functions below are compiled. Projects that already recorded version
-- 20260721010000 do not rerun it; their non-destructive upgrade path starts
-- with the forward-only 20260801 migrations.

create extension if not exists pgcrypto;

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  description text,
  image_url text,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint categories_slug_key unique (slug),
  constraint categories_slug_not_blank check (btrim(slug) <> '')
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id),
  brand text not null,
  name text not null,
  price numeric not null,
  sale_price numeric,
  emoji text,
  bg_color text,
  tags text[] not null default '{}'::text[],
  size text,
  movement text,
  case_size text,
  crystal text,
  water_resistance text,
  strap_type text,
  power_reserve text,
  stock_quantity integer not null default 0,
  description_en text,
  description_ar text,
  video_url text,
  model_3d_url text,
  is_active boolean not null default true,
  variants jsonb not null default '[]'::jsonb,
  era text,
  condition_rating smallint,
  orig_price_reference numeric,
  authentication_notes text,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint products_price_nonnegative check (price >= 0),
  constraint products_sale_price_valid check (
    sale_price is null or (sale_price >= 0 and sale_price < price)
  ),
  constraint products_stock_nonnegative check (stock_quantity >= 0),
  constraint products_condition_rating_range check (
    condition_rating is null or condition_rating between 1 and 5
  ),
  constraint products_original_price_nonnegative check (
    orig_price_reference is null or orig_price_reference >= 0
  ),
  constraint products_variants_shape check (
    jsonb_typeof(variants) in ('array', 'object')
  )
);

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  url text not null,
  position integer not null default 0,
  storage_path text,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint product_images_position_nonnegative check (position >= 0)
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending',
  total_amount numeric not null,
  payment_method text,
  payment_status text not null default 'unpaid',
  payment_id text,
  customer_name text,
  customer_phone text,
  customer_email text,
  shipping_address jsonb,
  notes text,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint orders_status_check check (
    status in ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded')
  ),
  constraint orders_total_nonnegative check (total_amount >= 0)
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  quantity integer not null,
  price_at_purchase numeric not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint order_items_quantity_positive check (quantity > 0),
  constraint order_items_price_nonnegative check (price_at_purchase >= 0)
);

create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamp with time zone not null default timezone('utc'::text, now())
);

create table public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  source text not null default 'newsletter',
  subscribed_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint subscribers_email_not_blank check (btrim(email) <> '')
);

create unique index subscribers_email_lower_key
  on public.subscribers (lower(btrim(email)));

create table public.notify_me (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  email text,
  phone text,
  contact_raw text,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint notify_me_contact_present check (
    nullif(btrim(email), '') is not null
    or nullif(btrim(phone), '') is not null
  )
);

create table public.episodes (
  id uuid primary key default gen_random_uuid(),
  episode_number integer not null,
  title_en text not null,
  title_ar text not null,
  description_en text,
  description_ar text,
  category text,
  duration text,
  video_url text,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint episodes_number_positive check (episode_number > 0)
);

create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  token text not null,
  device_name text,
  platform text,
  last_seen timestamp with time zone not null default timezone('utc'::text, now()),
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint push_tokens_token_key unique (token),
  constraint push_tokens_token_not_blank check (btrim(token) <> '')
);

alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.settings enable row level security;
alter table public.subscribers enable row level security;
alter table public.notify_me enable row level security;
alter table public.episodes enable row level security;
alter table public.push_tokens enable row level security;

revoke all on table public.categories from public, anon, authenticated;
revoke all on table public.products from public, anon, authenticated;
revoke all on table public.product_images from public, anon, authenticated;
revoke all on table public.orders from public, anon, authenticated;
revoke all on table public.order_items from public, anon, authenticated;
revoke all on table public.settings from public, anon, authenticated;
revoke all on table public.subscribers from public, anon, authenticated;
revoke all on table public.notify_me from public, anon, authenticated;
revoke all on table public.episodes from public, anon, authenticated;
revoke all on table public.push_tokens from public, anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;

grant select on table public.categories to anon, authenticated;
grant select on table public.products to anon, authenticated;
grant select on table public.product_images to anon, authenticated;
grant select on table public.settings to anon, authenticated;
grant select on table public.episodes to anon, authenticated;
grant insert (email, source) on table public.subscribers to anon, authenticated;
grant insert (product_id, email, phone, contact_raw)
  on table public.notify_me to anon, authenticated;

grant all on table public.categories to service_role;
grant all on table public.products to service_role;
grant all on table public.product_images to service_role;
grant all on table public.orders to service_role;
grant all on table public.order_items to service_role;
grant all on table public.settings to service_role;
grant all on table public.subscribers to service_role;
grant all on table public.notify_me to service_role;
grant all on table public.episodes to service_role;
grant all on table public.push_tokens to service_role;

create policy categories_select_public
  on public.categories for select
  to anon, authenticated
  using (true);

create policy products_select_active
  on public.products for select
  to anon, authenticated
  using (is_active is true);

create policy product_images_select_public
  on public.product_images for select
  to anon, authenticated
  using (true);

create policy settings_select_public
  on public.settings for select
  to anon, authenticated
  using (true);

create policy episodes_select_public
  on public.episodes for select
  to anon, authenticated
  using (true);

create policy subscribers_insert_public
  on public.subscribers for insert
  to anon, authenticated
  with check (btrim(email) <> '');

create policy notify_me_insert_public
  on public.notify_me for insert
  to anon, authenticated
  with check (
    nullif(btrim(email), '') is not null
    or nullif(btrim(phone), '') is not null
  );

-- Atomic, trusted and idempotent order creation for the create-order Edge Function.
-- Apply this migration before deploying the matching frontend/Edge Function code.

alter table public.products
  add column if not exists force_out_of_stock boolean not null default false;

alter table public.orders
  add column if not exists checkout_token text;

create unique index if not exists orders_checkout_token_key
  on public.orders (checkout_token)
  where checkout_token is not null;

-- The live project had broad temporary anon policies over order/customer
-- data. Checkout now uses the service-role RPC and order administration uses
-- the authenticated Express API, so those direct anon paths are unnecessary.
drop policy if exists orders_select_anon on public.orders;
drop policy if exists orders_update_anon on public.orders;
drop policy if exists orders_insert_anon on public.orders;
drop policy if exists order_items_select_anon on public.order_items;
drop policy if exists order_items_insert_anon on public.order_items;
drop policy if exists notify_me_select_anon on public.notify_me;
do $policy$
begin
  if to_regclass('public.subscribers') is not null then
    execute 'drop policy if exists subscribers_select_anon on public.subscribers';
  end if;
end
$policy$;

drop policy if exists "Users can create orders." on public.orders;
drop policy if exists "Authenticated users can create own orders." on public.orders;

create or replace function public.create_order_with_stock(
  p_order jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer jsonb;
  v_checkout_token text;
  v_total numeric := 0;
  v_order public.orders%rowtype;
begin
  if p_order is null or jsonb_typeof(p_order) <> 'object' then
    raise exception using message = 'invalid_order_data';
  end if;

  v_customer := p_order -> 'customer';
  if v_customer is null
     or jsonb_typeof(v_customer) <> 'object'
     or btrim(coalesce(v_customer ->> 'fn', '')) = ''
     or btrim(coalesce(v_customer ->> 'ph', '')) = '' then
    raise exception using message = 'invalid_customer_data';
  end if;

  if coalesce(jsonb_typeof(p_order -> 'total'), '') <> 'number' then
    raise exception using message = 'invalid_order_total';
  end if;

  if (p_order ->> 'total')::numeric < 0 then
    raise exception using message = 'invalid_order_total';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception using message = 'invalid_order_data';
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception using message = 'empty_order_items';
  end if;

  if jsonb_array_length(p_items) > 100 then
    raise exception using message = 'invalid_order_item';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as entry(item)
    where jsonb_typeof(item) <> 'object'
       or coalesce(item ->> 'pid', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or case
            when coalesce(item ->> 'qty', '') ~ '^[0-9]+$'
             and length(item ->> 'qty') <= 9
              then (item ->> 'qty')::integer < 1
                or (item ->> 'qty')::integer > 100000
            else true
          end
  ) then
    raise exception using message = 'invalid_order_item';
  end if;

  v_checkout_token := nullif(btrim(p_order ->> 'checkoutToken'), '');
  if v_checkout_token is null or length(v_checkout_token) > 128 then
    raise exception using message = 'invalid_order_data';
  end if;

  -- Serialize retries for the same checkout before checking/inserting. This
  -- makes a double-click or a response-loss retry return the original order.
  perform pg_advisory_xact_lock(hashtextextended(v_checkout_token, 0));

  select *
    into v_order
    from public.orders
   where checkout_token = v_checkout_token;

  if found then
    return to_jsonb(v_order);
  end if;

  -- Lock every requested product in a stable order before checking stock.
  perform product.id
    from public.products as product
    join (
      select (item ->> 'pid')::uuid as product_id
      from jsonb_array_elements(p_items) as entry(item)
      group by (item ->> 'pid')::uuid
    ) as requested on requested.product_id = product.id
   order by product.id
   for update of product;

  if exists (
    select 1
    from (
      select (item ->> 'pid')::uuid as product_id
      from jsonb_array_elements(p_items) as entry(item)
      group by (item ->> 'pid')::uuid
    ) as requested
    left join public.products as product on product.id = requested.product_id
    where product.id is null
       or product.is_active is not true
       or product.force_out_of_stock is true
  ) then
    raise exception using message = 'product_not_found';
  end if;

  if exists (
    select 1
    from (
      select
        (item ->> 'pid')::uuid as product_id,
        sum((item ->> 'qty')::integer)::integer as quantity
      from jsonb_array_elements(p_items) as entry(item)
      group by (item ->> 'pid')::uuid
    ) as requested
    join public.products as product on product.id = requested.product_id
    where coalesce(product.stock_quantity, 0) < requested.quantity
  ) then
    raise exception using message = 'insufficient_stock';
  end if;

  select coalesce(round(sum(
    requested.quantity *
    case
      when product.sale_price is not null
       and product.sale_price >= 0
       and product.sale_price < product.price
        then product.sale_price
      else product.price
    end
  ), 2), 0)
    into v_total
    from (
      select
        (item ->> 'pid')::uuid as product_id,
        sum((item ->> 'qty')::integer)::integer as quantity
      from jsonb_array_elements(p_items) as entry(item)
      group by (item ->> 'pid')::uuid
    ) as requested
    join public.products as product on product.id = requested.product_id;

  if (p_order ->> 'total')::numeric <> v_total then
    raise exception using message = 'order_total_changed';
  end if;

  insert into public.orders (
    total_amount,
    payment_method,
    customer_name,
    customer_phone,
    customer_email,
    shipping_address,
    notes,
    checkout_token
  ) values (
    v_total,
    left(coalesce(p_order ->> 'payment', ''), 50),
    left(btrim(concat_ws(' ', v_customer ->> 'fn', v_customer ->> 'ln')), 120),
    left(btrim(v_customer ->> 'ph'), 30),
    nullif(left(btrim(coalesce(v_customer ->> 'email', '')), 320), ''),
    v_customer,
    nullif(left(btrim(coalesce(p_order ->> 'notes', '')), 1000), ''),
    v_checkout_token
  )
  returning * into v_order;

  insert into public.order_items (
    order_id,
    product_id,
    quantity,
    price_at_purchase,
    metadata
  )
  select
    v_order.id,
    product.id,
    (item ->> 'qty')::integer,
    case
      when product.sale_price is not null
       and product.sale_price >= 0
       and product.sale_price < product.price
        then product.sale_price
      else product.price
    end,
    (
      case
        when jsonb_typeof(item -> 'metadata') = 'object' then item -> 'metadata'
        else '{}'::jsonb
      end
      || case
           when coalesce(item ->> 'isSt', 'false') = 'true'
             then jsonb_build_object('type', 'strap', 'config', item -> 'strapConfig')
           else '{}'::jsonb
         end
      || jsonb_strip_nulls(jsonb_build_object(
           'product_name', product.name,
           'brand', product.brand,
           'emoji', product.emoji,
           'category_slug', category.slug
         ))
    )
  from jsonb_array_elements(p_items) as entry(item)
  join public.products as product on product.id = (item ->> 'pid')::uuid
  left join public.categories as category on category.id = product.category_id;

  update public.products as product
     set stock_quantity = coalesce(product.stock_quantity, 0) - requested.quantity
    from (
      select
        (item ->> 'pid')::uuid as product_id,
        sum((item ->> 'qty')::integer)::integer as quantity
      from jsonb_array_elements(p_items) as entry(item)
      group by (item ->> 'pid')::uuid
    ) as requested
   where product.id = requested.product_id;

  return to_jsonb(v_order);
end;
$$;

revoke all on function public.create_order_with_stock(jsonb, jsonb) from public;
revoke all on function public.create_order_with_stock(jsonb, jsonb) from anon;
revoke all on function public.create_order_with_stock(jsonb, jsonb) from authenticated;
grant execute on function public.create_order_with_stock(jsonb, jsonb) to service_role;

create or replace function public.adjust_product_stock(
  p_product_id uuid,
  p_delta integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products%rowtype;
begin
  if p_delta is null or p_delta <= 0 or p_delta > 100000 then
    raise exception using message = 'invalid_restock_quantity';
  end if;

  update public.products
     set stock_quantity = coalesce(stock_quantity, 0) + p_delta
   where id = p_product_id
  returning * into v_product;

  if not found then
    return null;
  end if;

  return to_jsonb(v_product);
end;
$$;

revoke all on function public.adjust_product_stock(uuid, integer) from public;
revoke all on function public.adjust_product_stock(uuid, integer) from anon;
revoke all on function public.adjust_product_stock(uuid, integer) from authenticated;
grant execute on function public.adjust_product_stock(uuid, integer) to service_role;

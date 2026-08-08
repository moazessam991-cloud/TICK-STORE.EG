-- Non-destructive convergence for projects that already recorded all five
-- 20260721-20260725 business migrations. This migration does not replace any
-- payment or stock function and never recreates the core live tables.

create extension if not exists pgcrypto;

do $core_tables$
declare
  v_table record;
  v_kind "char";
begin
  for v_table in
    select table_name
      from (values
        ('categories'),
        ('products'),
        ('product_images'),
        ('orders'),
        ('order_items'),
        ('settings'),
        ('notify_me'),
        ('episodes')
      ) as required(table_name)
  loop
    select c.relkind
      into v_kind
      from pg_class as c
      join pg_namespace as n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = v_table.table_name;

    if v_kind is null then
      raise exception using message = format(
        'phase1_schema_missing_table: public.%s must exist before convergence',
        v_table.table_name
      );
    end if;

    if v_kind not in ('r', 'p') then
      raise exception using message = format(
        'phase1_schema_incompatible_object: public.%s is not a table',
        v_table.table_name
      );
    end if;
  end loop;
end
$core_tables$;

create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  source text not null default 'newsletter',
  subscribed_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint subscribers_email_not_blank check (btrim(email) <> '')
);

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  token text not null,
  device_name text,
  platform text,
  last_seen timestamp with time zone not null default timezone('utc'::text, now()),
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint push_tokens_token_key unique (token),
  constraint push_tokens_token_not_blank check (btrim(token) <> '')
);

do $all_tables$
declare
  v_table record;
  v_kind "char";
begin
  for v_table in
    select table_name
      from (values
        ('categories'),
        ('products'),
        ('product_images'),
        ('orders'),
        ('order_items'),
        ('settings'),
        ('subscribers'),
        ('notify_me'),
        ('episodes'),
        ('push_tokens')
      ) as required(table_name)
  loop
    select c.relkind
      into v_kind
      from pg_class as c
      join pg_namespace as n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = v_table.table_name;

    if v_kind is null or v_kind not in ('r', 'p') then
      raise exception using message = format(
        'phase1_schema_incompatible_object: public.%s is not a table',
        v_table.table_name
      );
    end if;
  end loop;
end
$all_tables$;

-- These additions are nullable or have safe defaults. Required identity,
-- pricing, order and relationship columns are asserted below instead of being
-- invented on an incompatible live object.
alter table public.products
  add column if not exists category_id uuid,
  add column if not exists sale_price numeric,
  add column if not exists emoji text,
  add column if not exists bg_color text,
  add column if not exists tags text[] default '{}'::text[],
  add column if not exists size text,
  add column if not exists movement text,
  add column if not exists case_size text,
  add column if not exists crystal text,
  add column if not exists water_resistance text,
  add column if not exists strap_type text,
  add column if not exists power_reserve text,
  add column if not exists stock_quantity integer default 0,
  add column if not exists description_en text,
  add column if not exists description_ar text,
  add column if not exists video_url text,
  add column if not exists model_3d_url text,
  add column if not exists force_out_of_stock boolean default false,
  add column if not exists is_active boolean default true,
  add column if not exists variants jsonb default '[]'::jsonb,
  add column if not exists era text,
  add column if not exists condition_rating smallint,
  add column if not exists orig_price_reference numeric,
  add column if not exists authentication_notes text,
  add column if not exists created_at timestamp with time zone default timezone('utc'::text, now()),
  add column if not exists updated_at timestamp with time zone default timezone('utc'::text, now());

alter table public.product_images
  add column if not exists position integer,
  add column if not exists storage_path text,
  add column if not exists created_at timestamp with time zone default timezone('utc'::text, now());

alter table public.orders
  add column if not exists updated_at timestamp with time zone default timezone('utc'::text, now());

alter table public.subscribers
  add column if not exists source text default 'newsletter',
  add column if not exists subscribed_at timestamp with time zone default timezone('utc'::text, now());

alter table public.push_tokens
  add column if not exists device_name text,
  add column if not exists platform text,
  add column if not exists last_seen timestamp with time zone default timezone('utc'::text, now()),
  add column if not exists created_at timestamp with time zone default timezone('utc'::text, now());

-- Refuse to continue when a known column exists with a different PostgreSQL
-- type. IF NOT EXISTS above must never hide an incompatible live definition.
do $column_types$
declare
  v_column record;
  v_actual_type text;
begin
  for v_column in
    select table_name, column_name, expected_udt
      from (values
        ('categories', 'id', 'uuid'),
        ('categories', 'name', 'text'),
        ('categories', 'slug', 'text'),
        ('categories', 'description', 'text'),
        ('categories', 'image_url', 'text'),
        ('categories', 'created_at', 'timestamptz'),
        ('products', 'id', 'uuid'),
        ('products', 'category_id', 'uuid'),
        ('products', 'brand', 'text'),
        ('products', 'name', 'text'),
        ('products', 'price', 'numeric'),
        ('products', 'sale_price', 'numeric'),
        ('products', 'emoji', 'text'),
        ('products', 'bg_color', 'text'),
        ('products', 'tags', '_text'),
        ('products', 'size', 'text'),
        ('products', 'movement', 'text'),
        ('products', 'case_size', 'text'),
        ('products', 'crystal', 'text'),
        ('products', 'water_resistance', 'text'),
        ('products', 'strap_type', 'text'),
        ('products', 'power_reserve', 'text'),
        ('products', 'stock_quantity', 'int4'),
        ('products', 'description_en', 'text'),
        ('products', 'description_ar', 'text'),
        ('products', 'video_url', 'text'),
        ('products', 'model_3d_url', 'text'),
        ('products', 'force_out_of_stock', 'bool'),
        ('products', 'is_active', 'bool'),
        ('products', 'variants', 'jsonb'),
        ('products', 'era', 'text'),
        ('products', 'condition_rating', 'int2'),
        ('products', 'orig_price_reference', 'numeric'),
        ('products', 'authentication_notes', 'text'),
        ('products', 'created_at', 'timestamptz'),
        ('products', 'updated_at', 'timestamptz'),
        ('product_images', 'id', 'uuid'),
        ('product_images', 'product_id', 'uuid'),
        ('product_images', 'url', 'text'),
        ('product_images', 'position', 'int4'),
        ('product_images', 'storage_path', 'text'),
        ('product_images', 'created_at', 'timestamptz'),
        ('orders', 'id', 'uuid'),
        ('orders', 'status', 'text'),
        ('orders', 'total_amount', 'numeric'),
        ('orders', 'payment_method', 'text'),
        ('orders', 'payment_status', 'text'),
        ('orders', 'payment_id', 'text'),
        ('orders', 'customer_name', 'text'),
        ('orders', 'customer_phone', 'text'),
        ('orders', 'customer_email', 'text'),
        ('orders', 'shipping_address', 'jsonb'),
        ('orders', 'notes', 'text'),
        ('orders', 'checkout_token', 'text'),
        ('orders', 'payment_reference', 'text'),
        ('orders', 'payment_sender_name', 'text'),
        ('orders', 'payment_proof_path', 'text'),
        ('orders', 'payment_expires_at', 'timestamptz'),
        ('orders', 'payment_submitted_at', 'timestamptz'),
        ('orders', 'payment_verified_at', 'timestamptz'),
        ('orders', 'payment_verified_by', 'text'),
        ('orders', 'payment_rejected_at', 'timestamptz'),
        ('orders', 'payment_rejection_reason', 'text'),
        ('orders', 'stock_restored_at', 'timestamptz'),
        ('orders', 'created_at', 'timestamptz'),
        ('orders', 'updated_at', 'timestamptz'),
        ('order_items', 'id', 'uuid'),
        ('order_items', 'order_id', 'uuid'),
        ('order_items', 'product_id', 'uuid'),
        ('order_items', 'quantity', 'int4'),
        ('order_items', 'price_at_purchase', 'numeric'),
        ('order_items', 'metadata', 'jsonb'),
        ('order_items', 'created_at', 'timestamptz'),
        ('settings', 'key', 'text'),
        ('settings', 'value', 'jsonb'),
        ('settings', 'updated_at', 'timestamptz'),
        ('subscribers', 'id', 'uuid'),
        ('subscribers', 'email', 'text'),
        ('subscribers', 'source', 'text'),
        ('subscribers', 'subscribed_at', 'timestamptz'),
        ('notify_me', 'id', 'uuid'),
        ('notify_me', 'product_id', 'uuid'),
        ('notify_me', 'email', 'text'),
        ('notify_me', 'phone', 'text'),
        ('notify_me', 'contact_raw', 'text'),
        ('notify_me', 'created_at', 'timestamptz'),
        ('episodes', 'id', 'uuid'),
        ('episodes', 'episode_number', 'int4'),
        ('episodes', 'title_en', 'text'),
        ('episodes', 'title_ar', 'text'),
        ('episodes', 'description_en', 'text'),
        ('episodes', 'description_ar', 'text'),
        ('episodes', 'category', 'text'),
        ('episodes', 'duration', 'text'),
        ('episodes', 'video_url', 'text'),
        ('episodes', 'created_at', 'timestamptz'),
        ('push_tokens', 'id', 'uuid'),
        ('push_tokens', 'token', 'text'),
        ('push_tokens', 'device_name', 'text'),
        ('push_tokens', 'platform', 'text'),
        ('push_tokens', 'last_seen', 'timestamptz'),
        ('push_tokens', 'created_at', 'timestamptz')
      ) as expected(table_name, column_name, expected_udt)
  loop
    select c.udt_name
      into v_actual_type
      from information_schema.columns as c
     where c.table_schema = 'public'
       and c.table_name = v_column.table_name
       and c.column_name = v_column.column_name;

    if v_actual_type is null then
      raise exception using message = format(
        'phase1_schema_missing_column: public.%s.%s is required',
        v_column.table_name,
        v_column.column_name
      );
    end if;

    if v_actual_type <> v_column.expected_udt then
      raise exception using message = format(
        'phase1_schema_incompatible_type: public.%s.%s expected %s but found %s',
        v_column.table_name,
        v_column.column_name,
        v_column.expected_udt,
        v_actual_type
      );
    end if;
  end loop;
end
$column_types$;

-- Preserve display_order. Only copy it into the canonical position field when
-- legacy ordering is internally unique and the canonical value is null or is
-- demonstrably an all-zero/unset ordering for that product.
do $image_position_backfill$
declare
  v_has_display_order boolean;
  v_conflict boolean;
begin
  select exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'product_images'
       and column_name = 'display_order'
  ) into v_has_display_order;

  if v_has_display_order then
    execute $sql$
      select exists (
        with candidate_products as (
          select product_id
            from public.product_images
           group by product_id
          having bool_or(position is null)
             or bool_and(coalesce(position, 0) = 0)
        ), proposed as (
          select image.product_id,
                 coalesce(
                   case
                     when image.position is null
                       or not exists (
                         select 1
                           from public.product_images as sibling
                          where sibling.product_id = image.product_id
                            and sibling.position is not null
                            and sibling.position <> 0
                       )
                       then image.display_order
                     else image.position
                   end,
                   image.position,
                   0
                 ) as proposed_position
            from public.product_images as image
            join candidate_products as candidate
              on candidate.product_id = image.product_id
        )
        select 1
          from proposed
         group by product_id, proposed_position
        having count(*) > 1
      )
    $sql$ into v_conflict;

    if v_conflict then
      raise exception using message =
        'phase1_product_image_order_conflict: display_order cannot fill an unset position without duplicates';
    end if;

    execute $sql$
      update public.product_images as image
         set position = image.display_order
       where image.display_order is not null
         and (
           image.position is null
           or (
             image.position = 0
             and not exists (
               select 1
                 from public.product_images as sibling
                where sibling.product_id = image.product_id
                  and sibling.position is not null
                  and sibling.position <> 0
             )
           )
         )
    $sql$;
  end if;

  update public.product_images
     set position = 0
   where position is null;
end
$image_position_backfill$;

alter table public.product_images
  alter column position set default 0,
  alter column position set not null;

-- If these runtime-only tables were missing, expose only the minimum active
-- role contract. Existing policies on unrelated tables are deliberately left
-- for the later authorization-hardening phase.
alter table public.subscribers enable row level security;
alter table public.push_tokens enable row level security;

revoke all on table public.subscribers from public, anon, authenticated;
revoke all on table public.push_tokens from public, anon, authenticated;
grant insert (email, source) on table public.subscribers to anon, authenticated;
grant all on table public.subscribers to service_role;
grant all on table public.push_tokens to service_role;

do $subscriber_policy$
begin
  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'subscribers'
       and policyname = 'subscribers_insert_public'
  ) then
    execute $policy$
      create policy subscribers_insert_public
        on public.subscribers for insert
        to anon, authenticated
        with check (btrim(email) <> '')
    $policy$;
  end if;
end
$subscriber_policy$;

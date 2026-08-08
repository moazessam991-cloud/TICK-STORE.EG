-- Secure manual InstaPay payments with a strict five-minute confirmation
-- deadline. All state transitions and stock restoration stay inside locked
-- PostgreSQL transactions; browser clients never receive direct write access.

create extension if not exists pgcrypto;

alter table public.orders
  add column if not exists payment_reference text,
  add column if not exists payment_sender_name text,
  add column if not exists payment_proof_path text,
  add column if not exists payment_expires_at timestamp with time zone,
  add column if not exists payment_submitted_at timestamp with time zone,
  add column if not exists payment_verified_at timestamp with time zone,
  add column if not exists payment_verified_by text,
  add column if not exists payment_rejected_at timestamp with time zone,
  add column if not exists payment_rejection_reason text,
  add column if not exists stock_restored_at timestamp with time zone;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_instapay_payment_status_check'
  ) then
    alter table public.orders
      add constraint orders_instapay_payment_status_check
      check (
        payment_method is distinct from 'InstaPay'
        or payment_status in (
          'pending_payment',
          'awaiting_verification',
          'paid',
          'rejected',
          'expired'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_instapay_expiry_required_check'
  ) then
    alter table public.orders
      add constraint orders_instapay_expiry_required_check
      check (
        payment_method is distinct from 'InstaPay'
        or payment_expires_at is not null
      ) not valid;
  end if;
end
$constraints$;

create unique index if not exists orders_instapay_payment_reference_key
  on public.orders (payment_reference)
  where payment_method = 'InstaPay'
    and payment_reference is not null;

create index if not exists orders_instapay_expiry_due_idx
  on public.orders (payment_expires_at)
  where payment_method = 'InstaPay'
    and payment_status in ('pending_payment', 'awaiting_verification')
    and stock_restored_at is null;

-- The bucket is private. Only the service-role Express API uploads proofs or
-- creates one-minute signed URLs for authenticated admins.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'instapay-proofs',
  'instapay-proofs',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public._instapay_public_order_payload(
  p_order public.orders
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return jsonb_build_object(
    'id', p_order.id,
    'total_amount', p_order.total_amount,
    'payment_method', p_order.payment_method,
    'payment_status', p_order.payment_status,
    'status', p_order.status,
    'payment_reference', p_order.payment_reference,
    'payment_sender_name', p_order.payment_sender_name,
    'payment_expires_at', p_order.payment_expires_at,
    'payment_submitted_at', p_order.payment_submitted_at,
    'payment_verified_at', p_order.payment_verified_at,
    'payment_rejected_at', p_order.payment_rejected_at,
    'payment_rejection_reason', p_order.payment_rejection_reason,
    'created_at', p_order.created_at,
    'server_time', clock_timestamp()
  );
end;
$$;

revoke all on function public._instapay_public_order_payload(public.orders) from public;
revoke all on function public._instapay_public_order_payload(public.orders) from anon;
revoke all on function public._instapay_public_order_payload(public.orders) from authenticated;

-- Callers lock the order first. Re-locking it here is intentional: it makes
-- this helper safe even if a future backend caller invokes it directly.
create or replace function public._restore_instapay_stock_locked(
  p_order_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_marked uuid;
begin
  select *
    into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found
     or v_order.payment_method is distinct from 'InstaPay'
     or v_order.payment_status = 'paid'
     or v_order.stock_restored_at is not null then
    return false;
  end if;

  perform product.id
    from public.products as product
    join (
      select product_id, sum(quantity)::integer as quantity
        from public.order_items
       where order_id = p_order_id
         and product_id is not null
       group by product_id
    ) as reserved on reserved.product_id = product.id
   order by product.id
   for update of product;

  update public.products as product
     set stock_quantity = coalesce(product.stock_quantity, 0) + reserved.quantity
    from (
      select product_id, sum(quantity)::integer as quantity
        from public.order_items
       where order_id = p_order_id
         and product_id is not null
       group by product_id
    ) as reserved
   where product.id = reserved.product_id;

  update public.orders
     set stock_restored_at = clock_timestamp()
   where id = p_order_id
     and stock_restored_at is null
     and payment_status <> 'paid'
  returning id into v_marked;

  return v_marked is not null;
end;
$$;

revoke all on function public._restore_instapay_stock_locked(uuid) from public;
revoke all on function public._restore_instapay_stock_locked(uuid) from anon;
revoke all on function public._restore_instapay_stock_locked(uuid) from authenticated;

create or replace function public._expire_instapay_order_locked(
  p_order_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  select *
    into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found
     or v_order.payment_method is distinct from 'InstaPay'
     or v_order.payment_status not in ('pending_payment', 'awaiting_verification')
     or v_order.payment_expires_at > clock_timestamp() then
    return false;
  end if;

  update public.orders
     set payment_status = 'expired',
         status = 'cancelled'
   where id = p_order_id;

  perform public._restore_instapay_stock_locked(p_order_id);
  return true;
end;
$$;

revoke all on function public._expire_instapay_order_locked(uuid) from public;
revoke all on function public._expire_instapay_order_locked(uuid) from anon;
revoke all on function public._expire_instapay_order_locked(uuid) from authenticated;

-- Keep a product available until any five-minute reservation that references
-- it reaches a terminal state. Otherwise ON DELETE SET NULL would make exact
-- stock restoration impossible.
create or replace function public.prevent_unsettled_instapay_product_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
      from public.order_items as item
      join public.orders as payment_order on payment_order.id = item.order_id
     where item.product_id = old.id
       and payment_order.payment_method = 'InstaPay'
       and payment_order.payment_status in ('pending_payment', 'awaiting_verification')
       and payment_order.stock_restored_at is null
  ) then
    raise exception using message = 'product_has_unsettled_instapay_order';
  end if;

  return old;
end;
$$;

drop trigger if exists protect_unsettled_instapay_product_stock on public.products;
create trigger protect_unsettled_instapay_product_stock
  before delete on public.products
  for each row execute function public.prevent_unsettled_instapay_product_delete();

revoke all on function public.prevent_unsettled_instapay_product_delete() from public;
revoke all on function public.prevent_unsettled_instapay_product_delete() from anon;
revoke all on function public.prevent_unsettled_instapay_product_delete() from authenticated;

-- Replace the existing order RPC without changing its signature. COD keeps
-- its historical unpaid/no-expiry behavior; InstaPay receives its database
-- timestamp and state atomically with order creation and stock deduction.
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
  v_payment_method text;
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

  if coalesce(jsonb_typeof(p_order -> 'total'), '') <> 'number'
     or (p_order ->> 'total')::numeric < 0 then
    raise exception using message = 'invalid_order_total';
  end if;

  v_payment_method := case lower(btrim(coalesce(p_order ->> 'payment', '')))
    when 'cod' then 'COD'
    when 'instapay' then 'InstaPay'
    when 'visa' then 'Visa'
    else null
  end;

  if v_payment_method is null then
    raise exception using message = 'invalid_payment_method';
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

  perform pg_advisory_xact_lock(hashtextextended(v_checkout_token, 0));

  select *
    into v_order
    from public.orders
   where checkout_token = v_checkout_token;

  if found then
    return (
      to_jsonb(v_order)
      - 'checkout_token'
      - 'payment_proof_path'
    ) || jsonb_build_object('idempotent_replay', true);
  end if;

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
    payment_status,
    payment_expires_at,
    status,
    customer_name,
    customer_phone,
    customer_email,
    shipping_address,
    notes,
    checkout_token
  ) values (
    v_total,
    v_payment_method,
    case when v_payment_method = 'InstaPay' then 'pending_payment' else 'unpaid' end,
    case when v_payment_method = 'InstaPay' then clock_timestamp() + interval '5 minutes' else null end,
    'pending',
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
           'category_slug', category.slug,
           'stock_product_id', product.id
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

  return (
    to_jsonb(v_order)
    - 'checkout_token'
    - 'payment_proof_path'
  ) || jsonb_build_object('idempotent_replay', false);
end;
$$;

revoke all on function public.create_order_with_stock(jsonb, jsonb) from public;
revoke all on function public.create_order_with_stock(jsonb, jsonb) from anon;
revoke all on function public.create_order_with_stock(jsonb, jsonb) from authenticated;
grant execute on function public.create_order_with_stock(jsonb, jsonb) to service_role;

create or replace function public.get_instapay_order_for_customer(
  p_order_id uuid,
  p_checkout_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  if p_checkout_token is null
     or length(p_checkout_token) < 16
     or length(p_checkout_token) > 128 then
    return null;
  end if;

  select *
    into v_order
    from public.orders
   where id = p_order_id
     and checkout_token = p_checkout_token
     and payment_method = 'InstaPay'
   for update;

  if not found then
    return null;
  end if;

  perform public._expire_instapay_order_locked(v_order.id);

  select * into v_order
    from public.orders
   where id = p_order_id;

  return public._instapay_public_order_payload(v_order);
end;
$$;

revoke all on function public.get_instapay_order_for_customer(uuid, text) from public;
revoke all on function public.get_instapay_order_for_customer(uuid, text) from anon;
revoke all on function public.get_instapay_order_for_customer(uuid, text) from authenticated;
grant execute on function public.get_instapay_order_for_customer(uuid, text) to service_role;

create or replace function public.submit_instapay_payment_proof(
  p_order_id uuid,
  p_checkout_token text,
  p_reference text,
  p_sender_name text,
  p_proof_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_reference text;
  v_sender_name text;
begin
  v_reference := upper(regexp_replace(btrim(coalesce(p_reference, '')), '[[:space:]-]+', '', 'g'));
  v_sender_name := regexp_replace(btrim(coalesce(p_sender_name, '')), '[[:space:]]+', ' ', 'g');

  if v_reference !~ '^[A-Z0-9]{6,64}$' then
    raise exception using message = 'invalid_payment_reference';
  end if;

  if length(v_sender_name) < 2 or length(v_sender_name) > 100 then
    raise exception using message = 'invalid_payment_sender_name';
  end if;

  if p_proof_path !~ ('^orders/' || p_order_id::text || '/[0-9a-f-]{36}[.](jpg|png|webp)$') then
    raise exception using message = 'invalid_payment_proof_path';
  end if;

  select *
    into v_order
    from public.orders
   where id = p_order_id
     and checkout_token = p_checkout_token
     and payment_method = 'InstaPay'
   for update;

  if not found then
    return null;
  end if;

  perform public._expire_instapay_order_locked(v_order.id);
  select * into v_order from public.orders where id = p_order_id;

  if v_order.payment_status <> 'pending_payment'
     or v_order.status in ('cancelled', 'refunded') then
    return public._instapay_public_order_payload(v_order)
      || jsonb_build_object('proof_accepted', false);
  end if;

  update public.orders
     set payment_reference = v_reference,
         payment_sender_name = v_sender_name,
         payment_proof_path = p_proof_path,
         payment_submitted_at = clock_timestamp(),
         payment_status = 'awaiting_verification'
   where id = p_order_id
     and payment_status = 'pending_payment'
     and status not in ('cancelled', 'refunded')
     and payment_expires_at > clock_timestamp()
  returning * into v_order;

  if not found then
    perform public._expire_instapay_order_locked(p_order_id);
    select * into v_order from public.orders where id = p_order_id;
    return public._instapay_public_order_payload(v_order)
      || jsonb_build_object('proof_accepted', false);
  end if;

  return public._instapay_public_order_payload(v_order)
    || jsonb_build_object('proof_accepted', true);
end;
$$;

revoke all on function public.submit_instapay_payment_proof(uuid, text, text, text, text) from public;
revoke all on function public.submit_instapay_payment_proof(uuid, text, text, text, text) from anon;
revoke all on function public.submit_instapay_payment_proof(uuid, text, text, text, text) from authenticated;
grant execute on function public.submit_instapay_payment_proof(uuid, text, text, text, text) to service_role;

create or replace function public.confirm_instapay_payment(
  p_order_id uuid,
  p_verified_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  select *
    into v_order
    from public.orders
   where id = p_order_id
     and payment_method = 'InstaPay'
   for update;

  if not found then
    return null;
  end if;

  if v_order.payment_status = 'paid' then
    return public._instapay_public_order_payload(v_order)
      || jsonb_build_object('changed', false);
  end if;

  perform public._expire_instapay_order_locked(v_order.id);
  select * into v_order from public.orders where id = p_order_id;

  if v_order.payment_status <> 'awaiting_verification'
     or v_order.status in ('cancelled', 'refunded') then
    return public._instapay_public_order_payload(v_order)
      || jsonb_build_object('changed', false);
  end if;

  update public.orders
     set payment_status = 'paid',
         status = 'confirmed',
         payment_verified_at = clock_timestamp(),
         payment_verified_by = left(btrim(coalesce(p_verified_by, 'admin')), 120)
   where id = p_order_id
     and payment_status = 'awaiting_verification'
     and status not in ('cancelled', 'refunded')
     and payment_expires_at > clock_timestamp()
  returning * into v_order;

  if not found then
    perform public._expire_instapay_order_locked(p_order_id);
    select * into v_order from public.orders where id = p_order_id;
    return public._instapay_public_order_payload(v_order)
      || jsonb_build_object('changed', false);
  end if;

  return public._instapay_public_order_payload(v_order)
    || jsonb_build_object('changed', true);
end;
$$;

revoke all on function public.confirm_instapay_payment(uuid, text) from public;
revoke all on function public.confirm_instapay_payment(uuid, text) from anon;
revoke all on function public.confirm_instapay_payment(uuid, text) from authenticated;
grant execute on function public.confirm_instapay_payment(uuid, text) to service_role;

create or replace function public.reject_instapay_payment(
  p_order_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_reason text;
begin
  v_reason := regexp_replace(btrim(coalesce(p_reason, '')), '[[:space:]]+', ' ', 'g');
  if length(v_reason) < 2 or length(v_reason) > 500 then
    raise exception using message = 'invalid_rejection_reason';
  end if;

  select *
    into v_order
    from public.orders
   where id = p_order_id
     and payment_method = 'InstaPay'
   for update;

  if not found then
    return null;
  end if;

  if v_order.payment_status in ('rejected', 'expired', 'paid') then
    return public._instapay_public_order_payload(v_order)
      || jsonb_build_object('changed', false);
  end if;

  perform public._expire_instapay_order_locked(v_order.id);
  select * into v_order from public.orders where id = p_order_id;

  if v_order.payment_status not in ('pending_payment', 'awaiting_verification') then
    return public._instapay_public_order_payload(v_order)
      || jsonb_build_object('changed', false);
  end if;

  update public.orders
     set payment_status = 'rejected',
         status = 'cancelled',
         payment_rejected_at = clock_timestamp(),
         payment_rejection_reason = v_reason
   where id = p_order_id
     and payment_status in ('pending_payment', 'awaiting_verification')
     and payment_expires_at > clock_timestamp()
  returning * into v_order;

  if not found then
    perform public._expire_instapay_order_locked(p_order_id);
    select * into v_order from public.orders where id = p_order_id;
    return public._instapay_public_order_payload(v_order)
      || jsonb_build_object('changed', false);
  end if;

  perform public._restore_instapay_stock_locked(p_order_id);
  select * into v_order from public.orders where id = p_order_id;

  return public._instapay_public_order_payload(v_order)
    || jsonb_build_object('changed', true);
end;
$$;

revoke all on function public.reject_instapay_payment(uuid, text) from public;
revoke all on function public.reject_instapay_payment(uuid, text) from anon;
revoke all on function public.reject_instapay_payment(uuid, text) from authenticated;
grant execute on function public.reject_instapay_payment(uuid, text) to service_role;

create or replace function public.expire_instapay_orders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_expired integer := 0;
begin
  for v_order in
    select id
      from public.orders
     where payment_method = 'InstaPay'
       and payment_status in ('pending_payment', 'awaiting_verification')
       and payment_expires_at <= clock_timestamp()
     order by payment_expires_at, id
     for update skip locked
  loop
    if public._expire_instapay_order_locked(v_order.id) then
      v_expired := v_expired + 1;
    end if;
  end loop;

  return v_expired;
end;
$$;

revoke all on function public.expire_instapay_orders() from public;
revoke all on function public.expire_instapay_orders() from anon;
revoke all on function public.expire_instapay_orders() from authenticated;
grant execute on function public.expire_instapay_orders() to service_role;

-- The following forward migration installs/verifies pg_cron before accessing
-- its schema, then creates exactly one expiry job. Keeping scheduling there
-- prevents this migration from querying cron.job on an incompatible host.

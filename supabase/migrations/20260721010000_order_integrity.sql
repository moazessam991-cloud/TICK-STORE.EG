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

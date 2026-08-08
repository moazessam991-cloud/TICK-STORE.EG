-- Allow an admin to cancel a confirmed order, including a manually confirmed
-- (paid) InstaPay order, without weakening any other payment/fulfilment guard.
-- Apply after 20260725010000_instapay_proof_stops_expiry.sql.

-- Keep the existing exact-restock primitive and durable marker. Paid stock is
-- still protected except after the cancellation RPC has atomically moved a
-- confirmed, paid InstaPay order to cancelled while holding its row lock.
create or replace function public._restore_order_stock_locked(
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

  if not found or v_order.stock_restored_at is not null then
    return false;
  end if;

  if v_order.payment_status is not distinct from 'paid'
     and not (
       v_order.payment_method is not distinct from 'InstaPay'
       and v_order.status is not distinct from 'cancelled'
     ) then
    return false;
  end if;

  if not exists (
    select 1 from public.order_items where order_id = p_order_id
  ) then
    raise exception using message = 'order_items_missing';
  end if;

  if exists (
    select 1
      from public.order_items
     where order_id = p_order_id
       and product_id is null
  ) then
    raise exception using message = 'order_stock_restore_unavailable';
  end if;

  perform product.id
    from public.products as product
    join (
      select product_id, sum(quantity)::integer as quantity
        from public.order_items
       where order_id = p_order_id
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
       group by product_id
    ) as reserved
   where product.id = reserved.product_id;

  update public.orders
     set stock_restored_at = clock_timestamp()
   where id = p_order_id
     and stock_restored_at is null
     and (
       payment_status is distinct from 'paid'
       or (
         payment_method is not distinct from 'InstaPay'
         and status is not distinct from 'cancelled'
       )
     )
  returning id into v_marked;

  return v_marked is not null;
end;
$$;

revoke all on function public._restore_order_stock_locked(uuid) from public;
revoke all on function public._restore_order_stock_locked(uuid) from anon;
revoke all on function public._restore_order_stock_locked(uuid) from authenticated;

-- This remains the single authoritative cancellation transaction. It locks
-- the order, validates the direct transition, changes status, restores stock,
-- and records stock_restored_at before the RPC transaction can commit.
create or replace function public.cancel_order_with_stock(
  p_order_id uuid,
  p_expected_payment_method text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_restored boolean;
  v_confirmed_paid_instapay boolean;
begin
  select *
    into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found then
    return null;
  end if;

  if p_expected_payment_method is not null
     and v_order.payment_method is distinct from p_expected_payment_method then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'stock_restored_at', v_order.stock_restored_at,
      'changed', false,
      'reason', 'payment_method_mismatch'
    );
  end if;

  v_confirmed_paid_instapay :=
    v_order.status is not distinct from 'confirmed'
    and v_order.payment_method is not distinct from 'InstaPay'
    and v_order.payment_status is not distinct from 'paid';

  -- A duplicate request after the newly supported transition is harmless.
  -- Rejected/expired InstaPay orders continue to use their payment action.
  if v_order.status is not distinct from 'cancelled'
     and v_order.payment_method is not distinct from 'InstaPay'
     and v_order.payment_status is not distinct from 'paid'
     and v_order.stock_restored_at is not null then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'stock_restored_at', v_order.stock_restored_at,
      'changed', false,
      'reason', 'already_cancelled'
    );
  end if;

  if v_order.payment_method is not distinct from 'InstaPay'
     and not v_confirmed_paid_instapay then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'stock_restored_at', v_order.stock_restored_at,
      'changed', false,
      'reason', 'use_instapay_payment_action'
    );
  end if;

  if v_order.payment_status is not distinct from 'paid'
     and not v_confirmed_paid_instapay then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'stock_restored_at', v_order.stock_restored_at,
      'changed', false,
      'reason', 'paid_order_cancellation_unsupported'
    );
  end if;

  if v_order.status = 'refunded' then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'stock_restored_at', v_order.stock_restored_at,
      'changed', false,
      'reason', 'refunded_order_protected'
    );
  end if;

  if v_order.status = 'cancelled' then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'stock_restored_at', v_order.stock_restored_at,
      'changed', false,
      'reason', 'already_cancelled'
    );
  end if;

  if v_order.stock_restored_at is not null then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'stock_restored_at', v_order.stock_restored_at,
      'changed', false,
      'reason', 'stock_already_restored'
    );
  end if;

  if v_order.status not in ('pending', 'confirmed') then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'stock_restored_at', v_order.stock_restored_at,
      'changed', false,
      'reason', 'order_state_not_cancellable'
    );
  end if;

  update public.orders
     set status = 'cancelled',
         payment_status = case
           when payment_method = 'Visa' then 'failed'
           else payment_status
         end
   where id = p_order_id;

  v_restored := public._restore_order_stock_locked(p_order_id);
  if not v_restored then
    raise exception using message = 'order_stock_restore_failed';
  end if;

  select * into v_order from public.orders where id = p_order_id;

  return jsonb_build_object(
    'id', v_order.id,
    'status', v_order.status,
    'payment_status', v_order.payment_status,
    'stock_restored_at', v_order.stock_restored_at,
    'changed', true,
    'reason', null
  );
end;
$$;

revoke all on function public.cancel_order_with_stock(uuid, text) from public;
revoke all on function public.cancel_order_with_stock(uuid, text) from anon;
revoke all on function public.cancel_order_with_stock(uuid, text) from authenticated;
grant execute on function public.cancel_order_with_stock(uuid, text) to service_role;

-- Harden generic order cancellation and make InstaPay cron setup verifiable.
-- Apply after 20260724010000_instapay_payment_flow.sql.

-- Shared stock restoration primitive. Callers must lock and validate the
-- order transition first. Re-locking the order here makes the helper safe if
-- a future database caller invokes it directly.
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

  if not found
     or v_order.payment_status is not distinct from 'paid'
     or v_order.stock_restored_at is not null then
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
     and payment_status is distinct from 'paid'
  returning id into v_marked;

  return v_marked is not null;
end;
$$;

revoke all on function public._restore_order_stock_locked(uuid) from public;
revoke all on function public._restore_order_stock_locked(uuid) from anon;
revoke all on function public._restore_order_stock_locked(uuid) from authenticated;

-- Preserve the existing InstaPay helper name used by rejection and expiry,
-- while routing it through the shared exact-restock primitive.
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
begin
  select *
    into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found
     or v_order.payment_method is distinct from 'InstaPay'
     or v_order.payment_status is not distinct from 'paid'
     or v_order.stock_restored_at is not null then
    return false;
  end if;

  return public._restore_order_stock_locked(p_order_id);
end;
$$;

revoke all on function public._restore_instapay_stock_locked(uuid) from public;
revoke all on function public._restore_instapay_stock_locked(uuid) from anon;
revoke all on function public._restore_instapay_stock_locked(uuid) from authenticated;

-- Generic cancellation is deliberately unavailable to InstaPay. Pending
-- InstaPay orders must use reject_instapay_payment(), which owns their
-- payment-state transition. Paid/refunded/fulfilled orders are protected.
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

  if v_order.payment_method = 'InstaPay' then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'stock_restored_at', v_order.stock_restored_at,
      'changed', false,
      'reason', 'use_instapay_payment_action'
    );
  end if;

  if v_order.payment_status is not distinct from 'paid' then
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

-- Serialize ordinary fulfilment changes with cancellation/payment changes.
-- Monotonic transitions prevent an admin from moving a shipped/delivered
-- order backwards to a cancellable state and then restoring unavailable stock.
create or replace function public.update_order_fulfillment_status(
  p_order_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_status text;
  v_current_rank integer;
  v_target_rank integer;
begin
  v_status := lower(btrim(coalesce(p_status, '')));
  if v_status not in ('pending', 'confirmed', 'shipped', 'delivered') then
    raise exception using message = 'invalid_status';
  end if;

  select *
    into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found then
    return null;
  end if;

  if v_order.status in ('cancelled', 'refunded') then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'changed', false,
      'reason', 'terminal_order_status'
    );
  end if;

  if v_status in ('shipped', 'delivered')
     and v_order.payment_method in ('InstaPay', 'Visa')
     and v_order.payment_status is distinct from 'paid' then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'changed', false,
      'reason', 'payment_required_before_fulfillment'
    );
  end if;

  v_current_rank := case v_order.status
    when 'pending' then 1
    when 'confirmed' then 2
    when 'shipped' then 3
    when 'delivered' then 4
    else 0
  end;
  v_target_rank := case v_status
    when 'pending' then 1
    when 'confirmed' then 2
    when 'shipped' then 3
    when 'delivered' then 4
  end;

  if v_target_rank < v_current_rank then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'changed', false,
      'reason', 'order_status_regression_blocked'
    );
  end if;

  if v_status = v_order.status then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'changed', false,
      'reason', 'already_in_status'
    );
  end if;

  update public.orders
     set status = v_status
   where id = p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'id', v_order.id,
    'status', v_order.status,
    'payment_status', v_order.payment_status,
    'changed', true,
    'reason', null
  );
end;
$$;

revoke all on function public.update_order_fulfillment_status(uuid, text) from public;
revoke all on function public.update_order_fulfillment_status(uuid, text) from anon;
revoke all on function public.update_order_fulfillment_status(uuid, text) from authenticated;
grant execute on function public.update_order_fulfillment_status(uuid, text) to service_role;

-- The hidden card webhook also needs a locked confirmation transition so a
-- late callback cannot mark an already-cancelled/restocked order as paid.
create or replace function public.confirm_card_payment(
  p_order_id uuid,
  p_transaction_id text,
  p_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_transaction_id text;
begin
  v_transaction_id := btrim(coalesce(p_transaction_id, ''));
  if length(v_transaction_id) < 1 or length(v_transaction_id) > 120 then
    raise exception using message = 'invalid_payment_transaction';
  end if;

  select *
    into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found then
    return null;
  end if;

  if v_order.payment_method is distinct from 'Visa' then
    return jsonb_build_object('id', v_order.id, 'changed', false, 'reason', 'payment_method_mismatch');
  end if;

  if v_order.payment_status = 'paid' then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'changed', false,
      'reason', case
        when v_order.payment_id = v_transaction_id then 'already_paid'
        else 'different_transaction_already_paid'
      end
    );
  end if;

  if v_order.status not in ('pending', 'confirmed')
     or v_order.stock_restored_at is not null then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'changed', false,
      'reason', 'payment_not_confirmable'
    );
  end if;

  if p_amount is null or round(p_amount, 2) <> round(v_order.total_amount, 2) then
    return jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'changed', false,
      'reason', 'payment_amount_mismatch'
    );
  end if;

  update public.orders
     set status = 'confirmed',
         payment_status = 'paid',
         payment_id = v_transaction_id
   where id = p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'id', v_order.id,
    'status', v_order.status,
    'payment_status', v_order.payment_status,
    'changed', true,
    'reason', null
  );
end;
$$;

revoke all on function public.confirm_card_payment(uuid, text, numeric) from public;
revoke all on function public.confirm_card_payment(uuid, text, numeric) from anon;
revoke all on function public.confirm_card_payment(uuid, text, numeric) from authenticated;
grant execute on function public.confirm_card_payment(uuid, text, numeric) to service_role;

-- Product deletion must not erase the product_id needed to restore an active
-- reservation. Paid/fulfilled orders never use the generic restock flow.
create or replace function public.prevent_unsettled_order_product_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
      from public.order_items as item
      join public.orders as reserved_order on reserved_order.id = item.order_id
     where item.product_id = old.id
       and reserved_order.stock_restored_at is null
       and (
         (
           reserved_order.payment_method = 'InstaPay'
           and reserved_order.payment_status in ('pending_payment', 'awaiting_verification')
         )
         or (
           reserved_order.payment_method is distinct from 'InstaPay'
           and reserved_order.payment_status is distinct from 'paid'
           and reserved_order.status in ('pending', 'confirmed')
         )
       )
  ) then
    raise exception using message = 'product_has_unsettled_order';
  end if;

  return old;
end;
$$;

drop trigger if exists protect_unsettled_instapay_product_stock on public.products;
drop trigger if exists protect_unsettled_order_product_stock on public.products;
create trigger protect_unsettled_order_product_stock
  before delete on public.products
  for each row execute function public.prevent_unsettled_order_product_delete();

revoke all on function public.prevent_unsettled_order_product_delete() from public;
revoke all on function public.prevent_unsettled_order_product_delete() from anon;
revoke all on function public.prevent_unsettled_order_product_delete() from authenticated;

-- Product editing is legacy browser-side Supabase CRUD, but stock mutations
-- must still go through service-role order/restock functions protected by the
-- Express JWT. Reject direct PostgREST stock changes from browser JWT roles.
create or replace function public.prevent_browser_product_stock_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.role() in ('anon', 'authenticated')
     and new.stock_quantity is distinct from old.stock_quantity then
    raise exception using message = 'direct_product_stock_update_forbidden';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_product_stock_from_browser_update on public.products;
create trigger protect_product_stock_from_browser_update
  before update of stock_quantity on public.products
  for each row execute function public.prevent_browser_product_stock_change();

revoke all on function public.prevent_browser_product_stock_change() from public;
revoke all on function public.prevent_browser_product_stock_change() from anon;
revoke all on function public.prevent_browser_product_stock_change() from authenticated;

-- Custom Express JWT is the only admin authorization system. Remove direct
-- browser UPDATE policies for orders; service_role still bypasses RLS and can
-- call the locked functions above.
do $policies$
declare
  v_policy record;
begin
  for v_policy in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename = 'orders'
       and cmd in ('UPDATE', 'ALL')
       and roles && array['public', 'anon', 'authenticated']::name[]
  loop
    execute format('drop policy if exists %I on public.orders', v_policy.policyname);
  end loop;
end
$policies$;

-- Supabase currently ships pg_cron 1.6.x, and pg_cron >=1.5 supports
-- second-based schedules. Fail the migration clearly on incompatible hosts.
do $enable_cron$
begin
  execute 'create extension if not exists pg_cron';
exception when others then
  raise exception using
    message = 'instapay_cron_unavailable: enable the Supabase Cron/pg_cron extension and rerun this migration',
    detail = sqlerrm;
end
$enable_cron$;

do $cron_setup$
declare
  v_version text;
  v_major integer;
  v_minor integer;
  v_job record;
begin
  select extversion
    into v_version
    from pg_extension
   where extname = 'pg_cron';

  if v_version is null then
    raise exception using message =
      'instapay_cron_unavailable: enable the Supabase Cron/pg_cron extension and rerun this migration';
  end if;

  if to_regnamespace('cron') is null
     or to_regclass('cron.job') is null
     or to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(bigint)') is null then
    raise exception using message =
      'instapay_cron_unavailable: pg_cron is installed but its cron schema/functions are unavailable';
  end if;

  v_major := split_part(v_version, '.', 1)::integer;
  v_minor := split_part(v_version, '.', 2)::integer;
  if v_major < 1 or (v_major = 1 and v_minor < 5) then
    raise exception using message =
      'instapay_cron_version_unsupported: pg_cron 1.5 or newer is required for a 10-second schedule';
  end if;

  -- Replace the named job and any differently-named duplicate that invokes
  -- the same expiry function. cron functions are preferred over table writes.
  for v_job in
    select jobid
     from cron.job
     where jobname = 'tick-instapay-expiry'
        or position('expire_instapay_orders' in lower(command)) > 0
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;

  perform cron.schedule(
    'tick-instapay-expiry',
    '10 seconds',
    'select public.expire_instapay_orders();'
  );

  if (
    select count(*)
      from cron.job
     where position('expire_instapay_orders' in lower(command)) > 0
  ) <> 1
  or not exists (
    select 1
      from cron.job
     where jobname = 'tick-instapay-expiry'
       and schedule = '10 seconds'
       and command = 'select public.expire_instapay_orders();'
       and active is true
  ) then
    raise exception using message =
      'instapay_cron_setup_failed: expected one active 10-second tick-instapay-expiry job';
  end if;
end
$cron_setup$;

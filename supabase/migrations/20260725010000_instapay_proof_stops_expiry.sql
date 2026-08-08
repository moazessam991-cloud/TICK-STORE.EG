-- The five-minute InstaPay window governs proof submission only. Once a
-- valid proof is accepted, the reservation remains awaiting manual review
-- without another deadline. Apply after the two 20260724 InstaPay migrations.

-- The original constraint required a deadline for every InstaPay state.
-- Pending-payment orders still require one; all later states may clear it.
alter table public.orders
  drop constraint if exists orders_instapay_expiry_required_check;

alter table public.orders
  add constraint orders_instapay_expiry_required_check
  check (
    payment_method is distinct from 'InstaPay'
    or payment_status is distinct from 'pending_payment'
    or payment_expires_at is not null
  ) not valid;

-- Callers may invoke this directly or through the cron sweep/read path. The
-- row lock makes expiry serialize with proof submission and admin actions.
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
  v_expired uuid;
begin
  select *
    into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found
     or v_order.payment_method is distinct from 'InstaPay'
     or v_order.payment_status is distinct from 'pending_payment'
     or v_order.payment_expires_at is null
     or v_order.payment_expires_at > clock_timestamp()
     or v_order.status in ('cancelled', 'refunded') then
    return false;
  end if;

  update public.orders
     set payment_status = 'expired',
         status = 'cancelled'
   where id = p_order_id
     and payment_method = 'InstaPay'
     and payment_status = 'pending_payment'
     and payment_expires_at <= clock_timestamp()
     and status not in ('cancelled', 'refunded')
  returning id into v_expired;

  if v_expired is null then
    return false;
  end if;

  perform public._restore_instapay_stock_locked(p_order_id);
  return true;
end;
$$;

revoke all on function public._expire_instapay_order_locked(uuid) from public;
revoke all on function public._expire_instapay_order_locked(uuid) from anon;
revoke all on function public._expire_instapay_order_locked(uuid) from authenticated;

-- The reference, sender, private proof path, status change, and deadline
-- removal are committed atomically while the order row remains locked.
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

  -- If the locked pending order is already late, expiry wins in this same
  -- transaction and the subsequent proof transition is refused.
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
         payment_status = 'awaiting_verification',
         payment_expires_at = null
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

-- Awaiting-review orders are confirmable indefinitely. The order lock and
-- state predicate keep duplicate or terminal callbacks harmless.
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

  if v_order.payment_status <> 'awaiting_verification'
     or v_order.status in ('cancelled', 'refunded') then
    return public._instapay_public_order_payload(v_order)
      || jsonb_build_object('changed', false);
  end if;

  update public.orders
     set payment_status = 'paid',
         status = 'confirmed',
         payment_expires_at = null,
         payment_verified_at = clock_timestamp(),
         payment_verified_by = left(btrim(coalesce(p_verified_by, 'admin')), 120)
   where id = p_order_id
     and payment_status = 'awaiting_verification'
     and status not in ('cancelled', 'refunded')
  returning * into v_order;

  if not found then
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

-- Pending orders can still be rejected before their payment window closes;
-- awaiting-review orders can be rejected at any later time. Both paths use
-- the existing idempotent exact-restock helper.
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

  -- A late pending order expires; an awaiting-review order is ignored by the
  -- expiry primitive and remains eligible for this manual rejection.
  perform public._expire_instapay_order_locked(v_order.id);
  select * into v_order from public.orders where id = p_order_id;

  if v_order.payment_status not in ('pending_payment', 'awaiting_verification')
     or v_order.status in ('cancelled', 'refunded') then
    return public._instapay_public_order_payload(v_order)
      || jsonb_build_object('changed', false);
  end if;

  update public.orders
     set payment_status = 'rejected',
         status = 'cancelled',
         payment_expires_at = null,
         payment_rejected_at = clock_timestamp(),
         payment_rejection_reason = v_reason
   where id = p_order_id
     and status not in ('cancelled', 'refunded')
     and (
       payment_status = 'awaiting_verification'
       or (
         payment_status = 'pending_payment'
         and payment_expires_at > clock_timestamp()
       )
     )
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

-- Preserve the existing ten-second cron job. Its target now scans pending
-- payment windows only; proof-submitted rows are never selected.
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
       and payment_status = 'pending_payment'
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

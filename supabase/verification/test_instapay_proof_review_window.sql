-- Disposable/preview PostgreSQL verification for
-- 20260725010000_instapay_proof_stops_expiry.sql.
-- Prerequisites: apply all three InstaPay migrations with a migration-owner
-- connection. The automated checks run inside a transaction and roll back.
-- Do not run against production.

begin;

do $tests$
declare
  v_expiry_product uuid := gen_random_uuid();
  v_confirm_product uuid := gen_random_uuid();
  v_reject_product uuid := gen_random_uuid();
  v_late_product uuid := gen_random_uuid();
  v_duplicate_product uuid := gen_random_uuid();
  v_order jsonb;
  v_result jsonb;
  v_order_id uuid;
  v_other_order_id uuid;
  v_token text;
  v_other_token text;
  v_original_expiry timestamptz;
  v_stock integer;
begin
  insert into public.products (
    id, brand, name, price, sale_price, stock_quantity, is_active, force_out_of_stock
  ) values
    (v_expiry_product, 'TICK TEST', 'Pending expiry fixture', 100, null, 10, true, false),
    (v_confirm_product, 'TICK TEST', 'Awaiting confirm fixture', 100, null, 10, true, false),
    (v_reject_product, 'TICK TEST', 'Awaiting reject fixture', 100, null, 10, true, false),
    (v_late_product, 'TICK TEST', 'Late proof fixture', 100, null, 10, true, false),
    (v_duplicate_product, 'TICK TEST', 'Duplicate reference fixture', 100, null, 10, true, false);

  -- Pending without proof expires, restores exactly once, and cannot be
  -- affected by repeated sweep calls.
  v_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 200,
      'payment', 'InstaPay',
      'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'Pending Expiry', 'ph', '01000000101')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_expiry_product, 'qty', 2))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  update public.orders
     set payment_expires_at = clock_timestamp() - interval '1 second'
   where id = v_order_id;

  if public.expire_instapay_orders() <> 1 then
    raise exception 'pending expiry sweep did not expire exactly one order';
  end if;
  select stock_quantity into v_stock from public.products where id = v_expiry_product;
  if v_stock <> 10 then raise exception 'pending expiry restored %, expected 10', v_stock; end if;
  if not exists (
    select 1 from public.orders
     where id = v_order_id
       and payment_status = 'expired'
       and status = 'cancelled'
       and stock_restored_at is not null
  ) then
    raise exception 'pending expiry did not persist its terminal state and restoration marker';
  end if;
  perform public.expire_instapay_orders();
  perform public._expire_instapay_order_locked(v_order_id);
  select stock_quantity into v_stock from public.products where id = v_expiry_product;
  if v_stock <> 10 then raise exception 'repeated expiry restored stock twice'; end if;

  -- Accepted proof clears the deadline. Even a stale historical deadline in
  -- the past cannot make an awaiting-review order expire on sweep or read.
  v_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100,
      'payment', 'InstaPay',
      'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'Await Confirm', 'ph', '01000000102')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_confirm_product, 'qty', 1))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  v_original_expiry := (v_order ->> 'payment_expires_at')::timestamptz;
  v_result := public.submit_instapay_payment_proof(
    v_order_id, v_token, 'REVIEWCONFIRM01', 'Preview Sender',
    'orders/' || v_order_id || '/' || gen_random_uuid() || '.jpg'
  );
  if v_result ->> 'proof_accepted' <> 'true'
     or v_result ->> 'payment_status' <> 'awaiting_verification'
     or v_result ->> 'payment_expires_at' is not null then
    raise exception 'accepted proof did not enter deadline-free awaiting review';
  end if;

  -- Simulate an order written by the older migration whose original deadline
  -- is now past. Both scheduled and read-time expiry must ignore its status.
  update public.orders
     set payment_expires_at = v_original_expiry - interval '10 minutes'
   where id = v_order_id;
  perform public.expire_instapay_orders();
  v_result := public.get_instapay_order_for_customer(v_order_id, v_token);
  if v_result ->> 'payment_status' <> 'awaiting_verification' then
    raise exception 'awaiting review expired after its original deadline';
  end if;
  if exists (
    select 1 from public.orders
     where id = v_order_id
       and stock_restored_at is not null
  ) then
    raise exception 'awaiting review unexpectedly restored stock';
  end if;
  select stock_quantity into v_stock from public.products where id = v_confirm_product;
  if v_stock <> 9 then raise exception 'awaiting review did not keep stock reserved'; end if;

  v_result := public.confirm_instapay_payment(v_order_id, 'preview-admin');
  if v_result ->> 'changed' <> 'true' or v_result ->> 'payment_status' <> 'paid' then
    raise exception 'admin could not confirm after the original deadline';
  end if;
  perform public.expire_instapay_orders();
  if not exists (
    select 1 from public.orders
     where id = v_order_id
       and payment_status = 'paid'
       and status = 'confirmed'
       and stock_restored_at is null
  ) then
    raise exception 'paid order expired or gained a restoration marker';
  end if;
  select stock_quantity into v_stock from public.products where id = v_confirm_product;
  if v_stock <> 9 then raise exception 'paid order expired or restored stock'; end if;

  -- Manual rejection remains available after the original deadline and uses
  -- the existing durable marker to restore exactly once.
  v_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100,
      'payment', 'InstaPay',
      'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'Await Reject', 'ph', '01000000103')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_reject_product, 'qty', 1))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  v_result := public.submit_instapay_payment_proof(
    v_order_id, v_token, 'REVIEWREJECT01', 'Preview Sender',
    'orders/' || v_order_id || '/' || gen_random_uuid() || '.png'
  );
  update public.orders
     set payment_expires_at = clock_timestamp() - interval '1 day'
   where id = v_order_id;
  perform public.expire_instapay_orders();
  v_result := public.reject_instapay_payment(v_order_id, 'manual verification failed');
  if v_result ->> 'changed' <> 'true' or v_result ->> 'payment_status' <> 'rejected' then
    raise exception 'admin could not reject awaiting review after the original deadline';
  end if;
  select stock_quantity into v_stock from public.products where id = v_reject_product;
  if v_stock <> 10 then raise exception 'rejection did not restore exact stock'; end if;
  v_result := public.reject_instapay_payment(v_order_id, 'duplicate rejection');
  select stock_quantity into v_stock from public.products where id = v_reject_product;
  if v_result ->> 'changed' <> 'false' or v_stock <> 10 then
    raise exception 'duplicate rejection restored stock twice';
  end if;
  v_result := public.confirm_instapay_payment(v_order_id, 'must-not-confirm');
  if v_result ->> 'changed' <> 'false' or v_result ->> 'payment_status' <> 'rejected' then
    raise exception 'rejected order was confirmed later';
  end if;

  -- A late proof loses to expiry and cannot revive the terminal order.
  v_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100,
      'payment', 'InstaPay',
      'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'Late Proof', 'ph', '01000000104')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_late_product, 'qty', 1))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  update public.orders
     set payment_expires_at = clock_timestamp() - interval '1 second'
   where id = v_order_id;
  v_result := public.submit_instapay_payment_proof(
    v_order_id, v_token, 'REVIEWLATE001', 'Late Sender',
    'orders/' || v_order_id || '/' || gen_random_uuid() || '.webp'
  );
  if v_result ->> 'proof_accepted' <> 'false' or v_result ->> 'payment_status' <> 'expired' then
    raise exception 'late proof revived or bypassed expiry';
  end if;
  select stock_quantity into v_stock from public.products where id = v_late_product;
  if v_stock <> 10 then raise exception 'late-proof expiry did not restore exact stock'; end if;

  -- The unique normalized reference remains enforced across orders. A failed
  -- duplicate transition leaves the second order pending rather than partly
  -- recording proof metadata.
  v_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100,
      'payment', 'InstaPay',
      'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'Reference One', 'ph', '01000000105')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_duplicate_product, 'qty', 1))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  perform public.submit_instapay_payment_proof(
    v_order_id, v_token, 'REVIEWDUP001', 'First Sender',
    'orders/' || v_order_id || '/' || gen_random_uuid() || '.jpg'
  );

  v_other_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100,
      'payment', 'InstaPay',
      'checkoutToken', v_other_token,
      'customer', jsonb_build_object('fn', 'Reference Two', 'ph', '01000000106')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_duplicate_product, 'qty', 1))
  );
  v_other_order_id := (v_order ->> 'id')::uuid;
  begin
    perform public.submit_instapay_payment_proof(
      v_other_order_id, v_other_token, 'REVIEW-DUP-001', 'Second Sender',
      'orders/' || v_other_order_id || '/' || gen_random_uuid() || '.jpg'
    );
    raise exception 'duplicate normalized reference was accepted';
  exception when unique_violation then
    null;
  end;
  if not exists (
    select 1 from public.orders
     where id = v_other_order_id
       and payment_status = 'pending_payment'
       and payment_reference is null
       and payment_expires_at is not null
  ) then
    raise exception 'duplicate reference partly transitioned the second order';
  end if;

  raise notice 'InstaPay proof-review window checks passed';
end
$tests$;

rollback;

-- The proof-versus-expiry boundary needs two independent sessions; a single
-- transaction cannot prove PostgreSQL lock waiting/skip-locked behavior.
--
-- PROOF WINS BEFORE DEADLINE
--   1. Create a pending fixture and retain its checkout token.
--   2. Session A: BEGIN; call submit_instapay_payment_proof(...); keep open.
--   3. Session B: SELECT public.expire_instapay_orders();
--      The locked row is skipped and the sweep returns without changing it.
--   4. Session A: COMMIT; rerun expiry after the original deadline.
--   5. Verify awaiting_verification, payment_expires_at IS NULL,
--      stock_restored_at IS NULL, and reserved stock remains deducted.
--
-- EXPIRY WINS AFTER DEADLINE
--   1. Create a pending fixture and set its deadline into the past.
--   2. Session A: BEGIN; call _expire_instapay_order_locked(id); keep open.
--   3. Session B: call submit_instapay_payment_proof(...); it waits.
--   4. Session A: COMMIT; Session B completes with proof_accepted=false.
--   5. Verify expired/cancelled, one stock_restored_at marker, exact original
--      stock, no proof metadata, and no awaiting_verification state.

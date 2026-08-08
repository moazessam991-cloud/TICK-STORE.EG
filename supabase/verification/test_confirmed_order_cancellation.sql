-- Disposable preview-environment integration checks for
-- 20260725020000_confirmed_order_cancellation.sql.
-- Prerequisites: apply all migrations through 20260725020000 with a
-- migration-owner connection. This test rolls back all fixtures.
-- Do not run against production.

begin;

do $tests$
declare
  v_confirmed_product uuid := gen_random_uuid();
  v_paid_instapay_product uuid := gen_random_uuid();
  v_awaiting_product uuid := gen_random_uuid();
  v_shipped_product uuid := gen_random_uuid();
  v_paid_card_product uuid := gen_random_uuid();
  v_bulk_product_a uuid := gen_random_uuid();
  v_bulk_product_b uuid := gen_random_uuid();
  v_order jsonb;
  v_result jsonb;
  v_order_id uuid;
  v_bulk_order_a uuid;
  v_bulk_order_b uuid;
  v_token text;
  v_stock integer;
  v_marker timestamptz;
begin
  insert into public.products (
    id, brand, name, price, sale_price, stock_quantity, is_active, force_out_of_stock
  ) values
    (v_confirmed_product, 'TICK TEST', 'Confirmed cancel fixture', 100, null, 10, true, false),
    (v_paid_instapay_product, 'TICK TEST', 'Paid InstaPay cancel fixture', 100, null, 10, true, false),
    (v_awaiting_product, 'TICK TEST', 'Awaiting rejection fixture', 100, null, 10, true, false),
    (v_shipped_product, 'TICK TEST', 'Shipped guard fixture', 100, null, 10, true, false),
    (v_paid_card_product, 'TICK TEST', 'Paid card guard fixture', 100, null, 10, true, false),
    (v_bulk_product_a, 'TICK TEST', 'Bulk cancel fixture A', 100, null, 10, true, false),
    (v_bulk_product_b, 'TICK TEST', 'Bulk cancel fixture B', 100, null, 10, true, false);

  -- Ordinary confirmed -> cancelled changes status and restores exact stock.
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 200, 'payment', 'COD', 'checkoutToken', gen_random_uuid()::text,
      'customer', jsonb_build_object('fn', 'Confirmed Cancel', 'ph', '01000000201')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_confirmed_product, 'qty', 2))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  v_result := public.update_order_fulfillment_status(v_order_id, 'confirmed');
  if v_result ->> 'changed' <> 'true' then raise exception 'fixture did not become confirmed'; end if;
  v_result := public.cancel_order_with_stock(v_order_id, null);
  if v_result ->> 'changed' <> 'true' or v_result ->> 'status' <> 'cancelled' then
    raise exception 'confirmed order did not cancel';
  end if;
  select stock_quantity into v_stock from public.products where id = v_confirmed_product;
  if v_stock <> 10 then raise exception 'confirmed cancellation restored %, expected 10', v_stock; end if;
  select stock_restored_at into v_marker from public.orders where id = v_order_id;
  if v_marker is null then raise exception 'confirmed cancellation did not set stock_restored_at'; end if;
  v_result := public.cancel_order_with_stock(v_order_id, null);
  select stock_quantity into v_stock from public.products where id = v_confirmed_product;
  if v_result ->> 'reason' <> 'already_cancelled' or v_stock <> 10 then
    raise exception 'duplicate confirmed cancellation restored twice';
  end if;
  v_result := public.update_order_fulfillment_status(v_order_id, 'confirmed');
  if v_result ->> 'reason' <> 'terminal_order_status' then
    raise exception 'cancelled order was revived';
  end if;

  -- A paid/confirmed InstaPay order now uses the same exact-once restock path.
  v_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 200, 'payment', 'InstaPay', 'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'Paid InstaPay Cancel', 'ph', '01000000202')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_paid_instapay_product, 'qty', 2))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  perform public.submit_instapay_payment_proof(
    v_order_id, v_token, 'CANCELPAID001', 'Preview Sender',
    'orders/' || v_order_id || '/' || gen_random_uuid() || '.jpg'
  );
  v_result := public.confirm_instapay_payment(v_order_id, 'preview-admin');
  if v_result ->> 'payment_status' <> 'paid' or v_result ->> 'status' <> 'confirmed' then
    raise exception 'paid InstaPay fixture was not confirmed';
  end if;
  v_result := public.cancel_order_with_stock(v_order_id, null);
  if v_result ->> 'changed' <> 'true'
     or v_result ->> 'status' <> 'cancelled'
     or v_result ->> 'payment_status' <> 'paid'
     or v_result ->> 'stock_restored_at' is null then
    raise exception 'paid confirmed InstaPay order did not cancel and restock';
  end if;
  select stock_quantity into v_stock from public.products where id = v_paid_instapay_product;
  if v_stock <> 10 then raise exception 'paid InstaPay cancellation restored %, expected 10', v_stock; end if;
  select stock_restored_at into v_marker from public.orders where id = v_order_id;
  v_result := public.cancel_order_with_stock(v_order_id, null);
  select stock_quantity into v_stock from public.products where id = v_paid_instapay_product;
  if v_result ->> 'reason' <> 'already_cancelled'
     or (v_result ->> 'stock_restored_at')::timestamptz is distinct from v_marker
     or v_stock <> 10 then
    raise exception 'duplicate paid InstaPay cancellation restored twice';
  end if;

  -- Awaiting-verification cancellation remains isolated to rejection.
  v_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100, 'payment', 'InstaPay', 'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'Awaiting Reject', 'ph', '01000000203')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_awaiting_product, 'qty', 1))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  perform public.submit_instapay_payment_proof(
    v_order_id, v_token, 'CANCELAWAIT001', 'Preview Sender',
    'orders/' || v_order_id || '/' || gen_random_uuid() || '.png'
  );
  v_result := public.cancel_order_with_stock(v_order_id, null);
  if v_result ->> 'reason' <> 'use_instapay_payment_action' then
    raise exception 'awaiting-verification generic cancellation changed behavior';
  end if;
  select stock_quantity into v_stock from public.products where id = v_awaiting_product;
  if v_stock <> 9 or exists (
    select 1 from public.orders where id = v_order_id and stock_restored_at is not null
  ) then
    raise exception 'awaiting-verification generic cancellation changed stock';
  end if;
  v_result := public.reject_instapay_payment(v_order_id, 'preview rejection');
  select stock_quantity into v_stock from public.products where id = v_awaiting_product;
  if v_result ->> 'payment_status' <> 'rejected' or v_stock <> 10 then
    raise exception 'awaiting-verification rejection no longer restores once';
  end if;

  -- Shipped and paid-card restrictions remain unchanged.
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100, 'payment', 'COD', 'checkoutToken', gen_random_uuid()::text,
      'customer', jsonb_build_object('fn', 'Shipped Guard', 'ph', '01000000204')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_shipped_product, 'qty', 1))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  perform public.update_order_fulfillment_status(v_order_id, 'confirmed');
  perform public.update_order_fulfillment_status(v_order_id, 'shipped');
  v_result := public.cancel_order_with_stock(v_order_id, null);
  if v_result ->> 'reason' <> 'order_state_not_cancellable' then
    raise exception 'shipped order was cancelled';
  end if;
  select stock_quantity into v_stock from public.products where id = v_shipped_product;
  if v_stock <> 9 then raise exception 'shipped order stock was restored'; end if;

  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100, 'payment', 'Visa', 'checkoutToken', gen_random_uuid()::text,
      'customer', jsonb_build_object('fn', 'Paid Card Guard', 'ph', '01000000205')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_paid_card_product, 'qty', 1))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  perform public.confirm_card_payment(v_order_id, 'cancel-guard-txn', 100);
  v_result := public.cancel_order_with_stock(v_order_id, null);
  if v_result ->> 'reason' <> 'paid_order_cancellation_unsupported' then
    raise exception 'paid Visa order was cancelled';
  end if;
  select stock_quantity into v_stock from public.products where id = v_paid_card_product;
  if v_stock <> 9 then raise exception 'paid Visa stock was restored'; end if;

  -- applyBulk() sends the same protected endpoint once per selected order.
  -- Exercise the corresponding pair of authoritative RPC transactions.
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100, 'payment', 'COD', 'checkoutToken', gen_random_uuid()::text,
      'customer', jsonb_build_object('fn', 'Bulk A', 'ph', '01000000206')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_bulk_product_a, 'qty', 1))
  );
  v_bulk_order_a := (v_order ->> 'id')::uuid;
  perform public.update_order_fulfillment_status(v_bulk_order_a, 'confirmed');
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100, 'payment', 'COD', 'checkoutToken', gen_random_uuid()::text,
      'customer', jsonb_build_object('fn', 'Bulk B', 'ph', '01000000207')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_bulk_product_b, 'qty', 1))
  );
  v_bulk_order_b := (v_order ->> 'id')::uuid;
  perform public.update_order_fulfillment_status(v_bulk_order_b, 'confirmed');
  v_result := public.cancel_order_with_stock(v_bulk_order_a, null);
  if v_result ->> 'status' <> 'cancelled' then raise exception 'bulk fixture A did not cancel'; end if;
  v_result := public.cancel_order_with_stock(v_bulk_order_b, null);
  if v_result ->> 'status' <> 'cancelled' then raise exception 'bulk fixture B did not cancel'; end if;
  if (select stock_quantity from public.products where id = v_bulk_product_a) <> 10
     or (select stock_quantity from public.products where id = v_bulk_product_b) <> 10 then
    raise exception 'bulk fixtures did not restore exact stock';
  end if;

  raise notice 'Confirmed order cancellation checks passed';
end
$tests$;

rollback;

-- CONCURRENT DUPLICATE CANCELLATION (two SQL sessions):
--   1. Create and confirm one fixture whose stock is lower by its order qty.
--   2. Session A: BEGIN; SELECT public.cancel_order_with_stock('<id>', null);
--      Keep the transaction open after the function returns.
--   3. Session B: SELECT public.cancel_order_with_stock('<id>', null); -- waits
--   4. Session A: COMMIT; Session B then returns already_cancelled.
--   5. Verify one changed=true result, one changed=false/already_cancelled
--      result, one non-null stock_restored_at, and exactly the original stock.

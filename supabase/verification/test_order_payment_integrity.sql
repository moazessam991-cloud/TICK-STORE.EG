-- Disposable preview-environment integration checks.
-- Prerequisites: apply both 20260724 migrations, then run this file with a
-- migration-owner/postgres connection. Everything in the automated block is
-- rolled back. Do not run against production.

begin;

do $tests$
declare
  v_product uuid := gen_random_uuid();
  v_validation_product uuid := gen_random_uuid();
  v_order jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_order_id uuid;
  v_stock integer;
  v_total numeric;
  v_expiry timestamptz;
  v_token text;
begin
  insert into public.products (
    id, brand, name, price, sale_price, stock_quantity, is_active, force_out_of_stock
  ) values
    (v_product, 'TICK TEST', 'Integrity fixture', 100, null, 50, true, false),
    (v_validation_product, 'TICK TEST', 'Validation fixture', 75, null, 2, true, false);

  -- COD: duplicate order_items aggregate, exact deduction, exact one-time
  -- restoration, duplicate cancellation, and immutable trusted total.
  v_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 300,
      'payment', 'COD',
      'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'COD Test', 'ph', '01000000001')
    ),
    jsonb_build_array(
      jsonb_build_object('pid', v_product, 'qty', 1, 'price', 1),
      jsonb_build_object('pid', v_product, 'qty', 2, 'price', 999999)
    )
  );
  v_order_id := (v_order ->> 'id')::uuid;
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock <> 47 then raise exception 'COD deduction expected 47, got %', v_stock; end if;

  v_result := public.cancel_order_with_stock(v_order_id, null);
  if v_result ->> 'changed' <> 'true' then raise exception 'COD cancellation did not change'; end if;
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock <> 50 then raise exception 'COD restock expected 50, got %', v_stock; end if;
  select total_amount into v_total from public.orders where id = v_order_id;
  if v_total <> 300 then raise exception 'COD total changed during cancellation'; end if;
  if (select stock_restored_at is null from public.orders where id = v_order_id) then
    raise exception 'COD stock restoration marker missing';
  end if;

  v_result := public.cancel_order_with_stock(v_order_id, null);
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_result ->> 'reason' <> 'already_cancelled' or v_stock <> 50 then
    raise exception 'duplicate COD cancellation was not idempotent';
  end if;

  -- Generic cancellation cannot cancel an InstaPay order.
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100,
      'payment', 'InstaPay',
      'checkoutToken', gen_random_uuid()::text,
      'customer', jsonb_build_object('fn', 'Insta Reject', 'ph', '01000000002')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_product, 'qty', 1, 'price', 0))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  v_result := public.cancel_order_with_stock(v_order_id, null);
  if v_result ->> 'reason' <> 'use_instapay_payment_action' then
    raise exception 'generic cancellation accepted InstaPay';
  end if;

  -- Proof succeeds before expiry. Rejection restores once; repeated rejection
  -- is harmless and the persisted total remains unchanged.
  v_result := public.submit_instapay_payment_proof(
    v_order_id,
    (select checkout_token from public.orders where id = v_order_id),
    'REFTEST0001',
    'Preview Sender',
    'orders/' || v_order_id || '/' || gen_random_uuid() || '.jpg'
  );
  if v_result ->> 'proof_accepted' <> 'true' then raise exception 'proof before expiry failed'; end if;
  v_result := public.reject_instapay_payment(v_order_id, 'preview rejection');
  if v_result ->> 'changed' <> 'true' then raise exception 'InstaPay rejection failed'; end if;
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock <> 50 then raise exception 'InstaPay rejection restock expected 50, got %', v_stock; end if;
  v_result := public.reject_instapay_payment(v_order_id, 'duplicate rejection');
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_result ->> 'changed' <> 'false' or v_stock <> 50 then
    raise exception 'duplicate InstaPay rejection restored twice';
  end if;
  select total_amount into v_total from public.orders where id = v_order_id;
  if v_total <> 100 then raise exception 'InstaPay rejection changed trusted total'; end if;

  -- Admin confirmation before expiry succeeds once; paid InstaPay cannot be
  -- rejected and does not restore stock.
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100,
      'payment', 'InstaPay',
      'checkoutToken', gen_random_uuid()::text,
      'customer', jsonb_build_object('fn', 'Insta Paid', 'ph', '01000000003')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_product, 'qty', 1, 'price', 0))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  v_result := public.submit_instapay_payment_proof(
    v_order_id,
    (select checkout_token from public.orders where id = v_order_id),
    'REFTEST0002',
    'Preview Sender',
    'orders/' || v_order_id || '/' || gen_random_uuid() || '.png'
  );
  v_result := public.confirm_instapay_payment(v_order_id, 'preview-admin');
  if v_result ->> 'changed' <> 'true' or v_result ->> 'payment_status' <> 'paid' then
    raise exception 'InstaPay confirmation before expiry failed';
  end if;
  v_result := public.confirm_instapay_payment(v_order_id, 'preview-admin');
  if v_result ->> 'changed' <> 'false' then raise exception 'duplicate confirmation changed state'; end if;
  v_result := public.reject_instapay_payment(v_order_id, 'must remain paid');
  if v_result ->> 'payment_status' <> 'paid' then raise exception 'paid InstaPay was rejected'; end if;
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock <> 49 then raise exception 'paid InstaPay unexpectedly restored stock'; end if;

  -- Database-created deadline is five minutes. Expiry-on-read, proof after
  -- expiry, confirmation after expiry, and repeated expiry are terminal and
  -- restore exactly once.
  v_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100,
      'payment', 'InstaPay',
      'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'Insta Expire', 'ph', '01000000004')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_product, 'qty', 1, 'price', 0))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  v_expiry := (v_order ->> 'payment_expires_at')::timestamptz;
  if v_expiry < clock_timestamp() + interval '4 minutes 59 seconds'
     or v_expiry > clock_timestamp() + interval '5 minutes 1 second' then
    raise exception 'InstaPay deadline is not five minutes';
  end if;
  update public.orders set payment_expires_at = clock_timestamp() - interval '1 second' where id = v_order_id;
  v_result := public.get_instapay_order_for_customer(v_order_id, v_token);
  if v_result ->> 'payment_status' <> 'expired' then raise exception 'read-time expiry failed'; end if;
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock <> 49 then raise exception 'expiry restock expected 49, got %', v_stock; end if;
  v_result := public.submit_instapay_payment_proof(
    v_order_id, v_token, 'REFTEST0003', 'Late Sender',
    'orders/' || v_order_id || '/' || gen_random_uuid() || '.webp'
  );
  if v_result ->> 'proof_accepted' <> 'false' or v_result ->> 'payment_status' <> 'expired' then
    raise exception 'proof after expiry was accepted';
  end if;
  v_result := public.confirm_instapay_payment(v_order_id, 'preview-admin');
  if v_result ->> 'payment_status' <> 'expired' then raise exception 'expired order became paid'; end if;
  perform public.expire_instapay_orders();
  perform public.expire_instapay_orders();
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock <> 49 then raise exception 'repeated expiry restored stock twice'; end if;

  -- Card confirmation locks the order, validates the trusted amount, blocks a
  -- later generic cancel, and never changes total_amount.
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 100,
      'payment', 'Visa',
      'checkoutToken', gen_random_uuid()::text,
      'customer', jsonb_build_object('fn', 'Card Paid', 'ph', '01000000005')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_product, 'qty', 1, 'price', 0))
  );
  v_order_id := (v_order ->> 'id')::uuid;
  v_result := public.confirm_card_payment(v_order_id, 'preview-txn-1', 99);
  if v_result ->> 'reason' <> 'payment_amount_mismatch' then raise exception 'card amount mismatch accepted'; end if;
  v_result := public.confirm_card_payment(v_order_id, 'preview-txn-1', 100);
  if v_result ->> 'changed' <> 'true' then raise exception 'valid card confirmation failed'; end if;
  v_result := public.cancel_order_with_stock(v_order_id, null);
  if v_result ->> 'reason' <> 'paid_order_cancellation_unsupported' then raise exception 'paid card order cancelled'; end if;
  select total_amount into v_total from public.orders where id = v_order_id;
  if v_total <> 100 then raise exception 'card transition changed trusted total'; end if;

  -- Checkout idempotency returns the same order and deducts once.
  v_token := gen_random_uuid()::text;
  v_order := public.create_order_with_stock(
    jsonb_build_object(
      'total', 75,
      'payment', 'COD',
      'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'Replay', 'ph', '01000000006')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_validation_product, 'qty', 1, 'price', 1))
  );
  v_replay := public.create_order_with_stock(
    jsonb_build_object(
      'total', 75,
      'payment', 'COD',
      'checkoutToken', v_token,
      'customer', jsonb_build_object('fn', 'Replay', 'ph', '01000000006')
    ),
    jsonb_build_array(jsonb_build_object('pid', v_validation_product, 'qty', 1, 'price', 999))
  );
  if v_order ->> 'id' <> v_replay ->> 'id' or v_replay ->> 'idempotent_replay' <> 'true' then
    raise exception 'checkout replay created a different order';
  end if;
  select stock_quantity into v_stock from public.products where id = v_validation_product;
  if v_stock <> 1 then raise exception 'checkout replay deducted twice'; end if;

  -- Client price is ignored, stale total is rejected, quantities/availability
  -- are validated, and COD is unaffected by the InstaPay expiry sweep.
  begin
    perform public.create_order_with_stock(
      jsonb_build_object(
        'total', 1, 'payment', 'COD', 'checkoutToken', gen_random_uuid()::text,
        'customer', jsonb_build_object('fn', 'Bad Total', 'ph', '01000000007')
      ),
      jsonb_build_array(jsonb_build_object('pid', v_validation_product, 'qty', 1, 'price', 1))
    );
    raise exception 'modified total was accepted';
  exception when others then
    if sqlerrm <> 'order_total_changed' then raise; end if;
  end;

  begin
    perform public.create_order_with_stock(
      jsonb_build_object(
        'total', 75, 'payment', 'COD', 'checkoutToken', gen_random_uuid()::text,
        'customer', jsonb_build_object('fn', 'Bad Quantity', 'ph', '01000000008')
      ),
      jsonb_build_array(jsonb_build_object('pid', v_validation_product, 'qty', 0, 'price', 75))
    );
    raise exception 'invalid quantity was accepted';
  exception when others then
    if sqlerrm <> 'invalid_order_item' then raise; end if;
  end;

  update public.products set force_out_of_stock = true where id = v_validation_product;
  begin
    perform public.create_order_with_stock(
      jsonb_build_object(
        'total', 75, 'payment', 'COD', 'checkoutToken', gen_random_uuid()::text,
        'customer', jsonb_build_object('fn', 'Forced Out', 'ph', '01000000009')
      ),
      jsonb_build_array(jsonb_build_object('pid', v_validation_product, 'qty', 1, 'price', 75))
    );
    raise exception 'force_out_of_stock product was accepted';
  exception when others then
    if sqlerrm <> 'product_not_found' then raise; end if;
  end;
  update public.products set force_out_of_stock = false, stock_quantity = 0 where id = v_validation_product;
  begin
    perform public.create_order_with_stock(
      jsonb_build_object(
        'total', 75, 'payment', 'COD', 'checkoutToken', gen_random_uuid()::text,
        'customer', jsonb_build_object('fn', 'No Stock', 'ph', '01000000010')
      ),
      jsonb_build_array(jsonb_build_object('pid', v_validation_product, 'qty', 1, 'price', 75))
    );
    raise exception 'out-of-stock product was accepted';
  exception when others then
    if sqlerrm <> 'insufficient_stock' then raise; end if;
  end;

  if exists (
    select 1 from public.orders
     where payment_method = 'COD' and payment_status = 'expired'
       and customer_phone like '010000000%'
  ) then
    raise exception 'expiry affected COD';
  end if;

  raise notice 'Disposable order/payment integrity checks passed';
end
$tests$;

rollback;

-- Concurrency checks require two SQL sessions because row-lock blocking cannot
-- be proven inside one transaction.
--
-- CONFIRM WINS (before deadline):
--   1. Create an awaiting_verification fixture and copy its order UUID.
--   2. Session A: BEGIN; SELECT * FROM public.orders WHERE id='<id>' FOR UPDATE;
--   3. Session B: SELECT public.expire_instapay_orders();  -- waits/skips lock
--   4. Session A: SELECT public.confirm_instapay_payment('<id>','race-admin'); COMMIT;
--   5. Rerun expiry and verify payment_status='paid', stock_restored_at IS NULL.
--
-- EXPIRY WINS (deadline passed):
--   1. Create a fixture, set payment_expires_at=clock_timestamp()-interval '1 second'.
--   2. Session A: BEGIN; SELECT public._expire_instapay_order_locked('<id>');
--      Keep the transaction open after the function returns.
--   3. Session B: SELECT public.confirm_instapay_payment('<id>','race-admin'); -- waits
--   4. Session A: COMMIT; Session B completes.
--   5. Verify payment_status='expired', status='cancelled', stock_restored_at
--      is non-null, and product stock increased by exactly the ordered quantity.
--
-- DUPLICATE CANCEL/REJECT:
--   Run cancel_order_with_stock() or reject_instapay_payment() simultaneously
--   in two sessions for the same fixture. Verify one changed=true result, one
--   harmless terminal result, one stock_restored_at, and exact original stock.

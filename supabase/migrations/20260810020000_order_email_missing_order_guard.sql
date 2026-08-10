create or replace function public.claim_order_email_notification(
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_row public.order_email_notifications%rowtype;
  v_now timestamp with time zone := clock_timestamp();
begin
  if p_order_id is null then
    raise exception using message = 'invalid_order_id';
  end if;

  -- Lock the parent order while establishing the notification claim.
  -- This makes a missing order a normal 404-style result instead of an FK error.
  perform 1
    from public.orders
   where id = p_order_id
   for key share;

  if not found then
    return jsonb_build_object(
      'claimed', false,
      'state', 'missing',
      'attempt_count', 0
    );
  end if;

  insert into public.order_email_notifications (
    order_id,
    state,
    attempt_count,
    updated_at
  )
  values (
    p_order_id,
    'sending',
    1,
    v_now
  )
  on conflict (order_id) do nothing
  returning * into v_row;

  if found then
    return jsonb_build_object(
      'claimed', true,
      'state', 'sending',
      'attempt_count', v_row.attempt_count
    );
  end if;

  select *
    into v_row
    from public.order_email_notifications
   where order_id = p_order_id
   for update;

  if not found then
    raise exception using message = 'notification_claim_failed';
  end if;

  if v_row.state = 'sent' then
    return jsonb_build_object(
      'claimed', false,
      'state', 'sent',
      'attempt_count', v_row.attempt_count
    );
  end if;

  if v_row.state = 'sending'
     and v_row.updated_at >= v_now - interval '5 minutes' then
    return jsonb_build_object(
      'claimed', false,
      'state', 'sending',
      'attempt_count', v_row.attempt_count
    );
  end if;

  update public.order_email_notifications
     set state = 'sending',
         attempt_count = attempt_count + 1,
         last_error = null,
         updated_at = v_now
   where order_id = p_order_id
   returning * into v_row;

  return jsonb_build_object(
    'claimed', true,
    'state', 'sending',
    'attempt_count', v_row.attempt_count
  );
end;
$$;

revoke all on function public.claim_order_email_notification(uuid)
  from public, anon, authenticated;

grant execute on function public.claim_order_email_notification(uuid)
  to service_role;

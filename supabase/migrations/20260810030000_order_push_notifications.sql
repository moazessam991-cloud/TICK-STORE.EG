create table if not exists public.order_push_deliveries (
  order_id uuid not null
    references public.orders(id) on delete cascade,

  push_token_id uuid not null
    references public.push_tokens(id) on delete cascade,

  state text not null default 'sending'
    constraint order_push_deliveries_state_check
    check (state in ('sending', 'sent', 'failed')),

  attempt_count integer not null default 1
    constraint order_push_deliveries_attempt_count_positive
    check (attempt_count > 0),

  provider_message_id text,
  last_error text,
  sent_at timestamp with time zone,
  created_at timestamp with time zone not null
    default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null
    default timezone('utc'::text, now()),

  primary key (order_id, push_token_id),

  constraint order_push_deliveries_sent_state_check
    check (
      (state = 'sent' and sent_at is not null)
      or
      (state <> 'sent')
    )
);

create index if not exists order_push_deliveries_push_token_id_idx
  on public.order_push_deliveries(push_token_id);

create index if not exists order_push_deliveries_state_updated_idx
  on public.order_push_deliveries(state, updated_at);

alter table public.order_push_deliveries enable row level security;

revoke all
  on table public.order_push_deliveries
  from public, anon, authenticated;

grant all
  on table public.order_push_deliveries
  to service_role;


create or replace function public.claim_order_push_delivery(
  p_order_id uuid,
  p_push_token_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery public.order_push_deliveries%rowtype;
begin
  -- Lock parent rows so concurrent deletion cannot create an FK race.
  perform 1
  from public.orders
  where id = p_order_id
  for key share;

  if not found then
    return jsonb_build_object(
      'claimed', false,
      'state', 'missing_order',
      'attempt_count', 0
    );
  end if;

  perform 1
  from public.push_tokens
  where id = p_push_token_id
  for key share;

  if not found then
    return jsonb_build_object(
      'claimed', false,
      'state', 'missing_token',
      'attempt_count', 0
    );
  end if;

  insert into public.order_push_deliveries (
    order_id,
    push_token_id,
    state,
    attempt_count
  )
  values (
    p_order_id,
    p_push_token_id,
    'sending',
    1
  )
  on conflict (order_id, push_token_id) do nothing
  returning *
  into v_delivery;

  if found then
    return jsonb_build_object(
      'claimed', true,
      'state', 'sending',
      'attempt_count', v_delivery.attempt_count
    );
  end if;

  select *
  into v_delivery
  from public.order_push_deliveries
  where order_id = p_order_id
    and push_token_id = p_push_token_id
  for update;

  if not found then
    return jsonb_build_object(
      'claimed', false,
      'state', 'missing',
      'attempt_count', 0
    );
  end if;

  if v_delivery.state = 'sent' then
    return jsonb_build_object(
      'claimed', false,
      'state', 'sent',
      'attempt_count', v_delivery.attempt_count
    );
  end if;

  -- Another invocation is already processing this device.
  if
    v_delivery.state = 'sending'
    and v_delivery.updated_at >
      timezone('utc'::text, now()) - interval '2 minutes'
  then
    return jsonb_build_object(
      'claimed', false,
      'state', 'sending',
      'attempt_count', v_delivery.attempt_count
    );
  end if;

  -- Retry a failed or stale delivery.
  update public.order_push_deliveries
  set
    state = 'sending',
    attempt_count = attempt_count + 1,
    provider_message_id = null,
    last_error = null,
    sent_at = null,
    updated_at = timezone('utc'::text, now())
  where order_id = p_order_id
    and push_token_id = p_push_token_id
  returning *
  into v_delivery;

  return jsonb_build_object(
    'claimed', true,
    'state', 'sending',
    'attempt_count', v_delivery.attempt_count
  );
end;
$$;


create or replace function public.finish_order_push_delivery(
  p_order_id uuid,
  p_push_token_id uuid,
  p_attempt_count integer,
  p_success boolean,
  p_provider_message_id text default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_attempt_count is null or p_attempt_count < 1 then
    return false;
  end if;

  update public.order_push_deliveries
  set
    state = case
      when p_success then 'sent'
      else 'failed'
    end,

    provider_message_id = case
      when p_success
        then left(p_provider_message_id, 500)
      else null
    end,

    last_error = case
      when p_success
        then null
      else left(coalesce(p_error, 'push_failed'), 500)
    end,

    sent_at = case
      when p_success
        then timezone('utc'::text, now())
      else null
    end,

    updated_at = timezone('utc'::text, now())

  where order_id = p_order_id
    and push_token_id = p_push_token_id
    and attempt_count = p_attempt_count
    and state = 'sending';

  return found;
end;
$$;


revoke all
  on function public.claim_order_push_delivery(uuid, uuid)
  from public, anon, authenticated;

revoke all
  on function public.finish_order_push_delivery(
    uuid,
    uuid,
    integer,
    boolean,
    text,
    text
  )
  from public, anon, authenticated;

grant execute
  on function public.claim_order_push_delivery(uuid, uuid)
  to service_role;

grant execute
  on function public.finish_order_push_delivery(
    uuid,
    uuid,
    integer,
    boolean,
    text,
    text
  )
  to service_role;

create table if not exists public.order_email_notifications (
  order_id uuid primary key
    references public.orders(id) on delete cascade,

  state text not null default 'sending',
  attempt_count integer not null default 1,

  provider_message_id text,
  last_error text,

  sent_at timestamp with time zone,
  created_at timestamp with time zone not null default clock_timestamp(),
  updated_at timestamp with time zone not null default clock_timestamp(),

  constraint order_email_notifications_state_check
    check (state in ('sending', 'sent', 'failed')),

  constraint order_email_notifications_attempt_count_check
    check (attempt_count > 0)
);

create index if not exists order_email_notifications_state_updated_idx
  on public.order_email_notifications (state, updated_at);

alter table public.order_email_notifications enable row level security;

revoke all on table public.order_email_notifications
  from public, anon, authenticated;

grant select, insert, update
  on table public.order_email_notifications
  to service_role;

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

  -- First caller atomically creates the claim.
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

  -- Existing claims are serialized on the row.
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


create or replace function public.finish_order_email_notification(
  p_order_id uuid,
  p_attempt_count integer,
  p_success boolean,
  p_provider_message_id text default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_order_id is null
     or p_attempt_count is null
     or p_attempt_count < 1
     or p_success is null then
    raise exception using message = 'invalid_notification_result';
  end if;

  update public.order_email_notifications
     set state = case when p_success then 'sent' else 'failed' end,
         provider_message_id = case
           when p_success then nullif(btrim(coalesce(p_provider_message_id, '')), '')
           else provider_message_id
         end,
         last_error = case
           when p_success then null
           else left(nullif(btrim(coalesce(p_error, '')), ''), 1000)
         end,
         sent_at = case when p_success then clock_timestamp() else sent_at end,
         updated_at = clock_timestamp()
   where order_id = p_order_id
     and state = 'sending'
     and attempt_count = p_attempt_count;

  return found;
end;
$$;

revoke all on function public.finish_order_email_notification(uuid, integer, boolean, text, text)
  from public, anon, authenticated;

grant execute on function public.finish_order_email_notification(uuid, integer, boolean, text, text)
  to service_role;

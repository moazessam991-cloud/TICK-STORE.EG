-- Forward-only limited-preview security controls.
-- This migration is intentionally not applied automatically by the hardening task.

create table public.order_abuse_counters (
  scope text not null,
  fingerprint text not null,
  window_started timestamp with time zone not null,
  attempt_count integer not null default 1,
  updated_at timestamp with time zone not null default clock_timestamp(),
  primary key (scope, fingerprint, window_started),
  constraint order_abuse_scope_check check (scope in ('ip', 'phone', 'checkout')),
  constraint order_abuse_fingerprint_check check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint order_abuse_attempt_count_positive check (attempt_count > 0)
);

create index order_abuse_counters_updated_at_idx
  on public.order_abuse_counters (updated_at);

alter table public.order_abuse_counters enable row level security;
revoke all on table public.order_abuse_counters from public, anon, authenticated;
grant all on table public.order_abuse_counters to service_role;

create or replace function public.consume_order_abuse_limits(
  p_ip_hash text,
  p_phone_hash text,
  p_checkout_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamp with time zone := clock_timestamp();
  v_rule record;
  v_window_started timestamp with time zone;
  v_attempt_count integer;
  v_retry_after integer;
begin
  if coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_phone_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_checkout_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'invalid_abuse_fingerprint';
  end if;

  -- Every request performs bounded retention cleanup. The index above keeps
  -- this cheap and prevents the durable limiter table growing without bound.
  delete from public.order_abuse_counters
   where updated_at < v_now - interval '24 hours';

  for v_rule in
    select *
      from (values
        ('ip'::text, p_ip_hash, interval '10 minutes', 5),
        ('phone'::text, p_phone_hash, interval '30 minutes', 3),
        ('checkout'::text, p_checkout_hash, interval '30 minutes', 3)
      ) as rules(scope, fingerprint, window_size, attempt_limit)
  loop
    v_window_started := date_bin(v_rule.window_size, v_now, timestamp with time zone '2000-01-01 00:00:00+00');

    insert into public.order_abuse_counters (
      scope,
      fingerprint,
      window_started,
      attempt_count,
      updated_at
    ) values (
      v_rule.scope,
      v_rule.fingerprint,
      v_window_started,
      1,
      v_now
    )
    on conflict (scope, fingerprint, window_started)
    do update
       set attempt_count = public.order_abuse_counters.attempt_count + 1,
           updated_at = excluded.updated_at
    returning attempt_count into v_attempt_count;

    if v_attempt_count > v_rule.attempt_limit then
      v_retry_after := greatest(
        1,
        ceil(extract(epoch from (v_window_started + v_rule.window_size - v_now)))::integer
      );
      return jsonb_build_object(
        'allowed', false,
        'scope', v_rule.scope,
        'retry_after_seconds', v_retry_after
      );
    end if;
  end loop;

  return jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
end;
$$;

revoke all on function public.consume_order_abuse_limits(text, text, text)
  from public, anon, authenticated;
grant execute on function public.consume_order_abuse_limits(text, text, text)
  to service_role;

-- These public commerce toggles are required for the preview checkout. Existing
-- owner choices win; only missing keys receive the safe current-scope defaults.
-- COD is on by default. InstaPay is off until the owner enables the database
-- setting and the Edge/Express runtime configuration independently.
insert into public.settings (key, value)
values
  ('cod', 'true'::jsonb),
  ('instapay', 'false'::jsonb)
on conflict (key) do nothing;

create or replace function public.create_preview_order_with_stock(
  p_order jsonb,
  p_items jsonb,
  p_phone_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_checkout_token text;
  v_payment_method text;
  v_phone_digits text;
  v_setting jsonb;
  v_enabled boolean := false;
  v_existing_order_id uuid;
  v_active_cod_count integer;
begin
  if p_order is null or jsonb_typeof(p_order) <> 'object'
     or p_items is null or jsonb_typeof(p_items) <> 'array'
     or coalesce(p_phone_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'invalid_order_data';
  end if;

  v_checkout_token := nullif(btrim(p_order ->> 'checkoutToken'), '');
  if v_checkout_token is null then
    raise exception using message = 'invalid_order_data';
  end if;

  -- Serialize the control-flow check with create_order_with_stock(). A replay
  -- delegates to that authoritative function so this wrapper never serializes
  -- orders%rowtype or creates a second public response contract.
  perform pg_advisory_xact_lock(hashtextextended(v_checkout_token, 0));
  select id
    into v_existing_order_id
    from public.orders
   where checkout_token = v_checkout_token;
  if found then
    return public.create_order_with_stock(p_order, p_items);
  end if;

  v_payment_method := case lower(btrim(coalesce(p_order ->> 'payment', '')))
    when 'cod' then 'COD'
    when 'instapay' then 'InstaPay'
    else null
  end;
  if v_payment_method is null then
    raise exception using message = 'invalid_payment_method';
  end if;

  select value
    into v_setting
    from public.settings
   where key = case when v_payment_method = 'COD' then 'cod' else 'instapay' end;

  -- Missing or malformed settings fail closed. The insert above establishes
  -- the only missing-row defaults during migration application; valid owner
  -- booleans are preserved by ON CONFLICT DO NOTHING.
  if found and jsonb_typeof(v_setting) = 'boolean' then
    v_enabled := (v_setting #>> '{}')::boolean;
  else
    v_enabled := false;
  end if;
  if v_enabled is not true then
    raise exception using message = 'payment_method_disabled';
  end if;

  if v_payment_method = 'COD' then
    v_phone_digits := regexp_replace(coalesce(p_order #>> '{customer,ph}', ''), '[^0-9]', '', 'g');
    if length(v_phone_digits) < 10 or length(v_phone_digits) > 15 then
      raise exception using message = 'invalid_customer_data';
    end if;

    -- Serialize the per-phone active-order check. A customer may have at most
    -- two pending/confirmed COD reservations in a rolling 24-hour window.
    perform pg_advisory_xact_lock(hashtextextended(p_phone_hash, 0));
    select count(*)::integer
      into v_active_cod_count
      from public.orders
     where payment_method = 'COD'
       and status in ('pending', 'confirmed')
       and created_at >= clock_timestamp() - interval '24 hours'
       and regexp_replace(coalesce(customer_phone, ''), '[^0-9]', '', 'g') = v_phone_digits;
    if v_active_cod_count >= 2 then
      raise exception using message = 'cod_active_order_limit';
    end if;
  end if;

  return public.create_order_with_stock(p_order, p_items);
end;
$$;

revoke all on function public.create_preview_order_with_stock(jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.create_preview_order_with_stock(jsonb, jsonb, text)
  to service_role;

create or replace function public.enforce_preview_payment_method()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.payment_method is null or new.payment_method not in ('COD', 'InstaPay') then
    raise exception using message = 'invalid_payment_method';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_preview_payment_method on public.orders;
create trigger enforce_preview_payment_method
  before insert or update of payment_method on public.orders
  for each row execute function public.enforce_preview_payment_method();

revoke all on function public.enforce_preview_payment_method()
  from public, anon, authenticated;

-- Settings are read through a public-safe Express projection. Direct table
-- reads could expose arbitrary historical keys, so remove every SELECT policy
-- and table privilege for browser roles.
do $settings_policies$
declare
  v_policy record;
begin
  for v_policy in
    select polname
      from pg_policy
     where polrelid = 'public.settings'::regclass
       and polcmd in ('r', '*')
  loop
    execute format('drop policy %I on public.settings', v_policy.polname);
  end loop;
end
$settings_policies$;

alter table public.settings enable row level security;
revoke all on table public.settings from public, anon, authenticated;
grant all on table public.settings to service_role;

-- Decommission the unused legacy Supabase-Auth profile surface without
-- deleting rows. This is safe on projects where profiles never existed.
do $profiles_hardening$
declare
  v_policy record;
begin
  if to_regclass('public.profiles') is not null then
    for v_policy in
      select polname
        from pg_policy
       where polrelid = 'public.profiles'::regclass
    loop
      execute format('drop policy %I on public.profiles', v_policy.polname);
    end loop;
    execute 'alter table public.profiles enable row level security';
    execute 'alter table public.profiles force row level security';
    execute 'revoke all on table public.profiles from public, anon, authenticated';
  end if;
end
$profiles_hardening$;

do $legacy_helpers$
declare
  v_function record;
  v_body text;
begin
  for v_function in
    select
      p.oid::regprocedure as identity,
      p.proname,
      p.pronargs,
      p.prosecdef,
      p.prosrc,
      pg_get_function_result(p.oid) as result_type,
      l.lanname as language_name
      from pg_proc as p
      join pg_namespace as n on n.oid = p.pronamespace
      join pg_language as l on l.oid = p.prolang
     where n.nspname = 'public'
       and p.proname in ('is_admin', 'handle_new_user')
  loop
    -- Repository compatibility is known only for the no-argument helpers in
    -- supabase_schema.sql. Stop rather than changing an unexpected overload.
    if v_function.pronargs <> 0 then
      raise exception using message = 'unexpected_legacy_helper_overload';
    end if;
    if not v_function.prosecdef or v_function.language_name <> 'plpgsql' then
      raise exception using message = 'legacy_helper_security_mode_requires_review';
    end if;

    v_body := lower(regexp_replace(v_function.prosrc, '\s+', '', 'g'));
    if v_function.proname = 'is_admin' then
      if v_function.result_type <> 'boolean'
         or strpos(v_body, 'frompublic.profiles') = 0
         or strpos(v_body, 'auth.uid()') = 0
         or strpos(v_body, 'execute') > 0 then
        raise exception using message = 'legacy_is_admin_definition_requires_review';
      end if;
    elsif v_function.proname = 'handle_new_user' then
      if v_function.result_type <> 'trigger'
         or strpos(v_body, 'insertintopublic.profiles') = 0
         or strpos(v_body, 'returnnew') = 0
         or strpos(v_body, 'execute') > 0 then
        raise exception using message = 'legacy_handle_new_user_definition_requires_review';
      end if;
    end if;

    -- auth.uid() in the known is_admin body is schema-qualified; the trigger
    -- body uses NEW plus public.profiles. Neither needs auth in search_path.
    execute format('alter function %s set search_path = pg_catalog, public', v_function.identity);
    execute format('revoke all on function %s from public, anon, authenticated', v_function.identity);
  end loop;
end
$legacy_helpers$;

-- SELECT-only pre/post-application verifier for
-- 20260808010000_preview_security_hardening.sql.
--
-- This file intentionally returns one consolidated result grid. PASS means
-- compatible, WARNING means an expected condition will be changed or fail
-- closed, BLOCKED means the migration contract is incompatible, and
-- CANNOT_VERIFY means the live definition needs manual review. No statement
-- exposes profile, order, or customer row data.

with
-- Migration-created routines and trigger distinguish a post-application
-- catalog from a clean pre-application catalog. The table and index are not
-- state markers because compatible same-name objects may predate application.
migration_markers as (
  select
    to_regprocedure('public.consume_order_abuse_limits(text,text,text)') is not null
      as consume_rpc_present,
    to_regprocedure('public.create_preview_order_with_stock(jsonb,jsonb,text)') is not null
      as preview_rpc_present,
    to_regprocedure('public.enforce_preview_payment_method()') is not null
      as payment_guard_present,
    exists (
      select 1
        from pg_trigger t
       where t.tgrelid = to_regclass('public.orders')
         and t.tgname = 'enforce_preview_payment_method'
         and not t.tgisinternal
    ) as payment_trigger_present
),
application_state as (
  select
    consume_rpc_present or preview_rpc_present or payment_guard_present
      or payment_trigger_present as post_apply_detected,
    jsonb_build_object(
      'consume_rpc_present', consume_rpc_present,
      'preview_rpc_present', preview_rpc_present,
      'payment_guard_present', payment_guard_present,
      'payment_trigger_present', payment_trigger_present
    ) as marker_detail
  from migration_markers
),

-- 1. Required relations/columns and names introduced by the migration.
object_contracts as (
  select
    to_regclass('public.settings') as settings_oid,
    to_regclass('public.orders') as orders_oid,
    to_regclass('public.profiles') as profiles_oid,
    to_regclass('public.order_abuse_counters') as abuse_oid,
    to_regclass('public.order_abuse_counters_updated_at_idx') as abuse_index_oid
),
object_facts as (
  select
    oc.*,
    app.post_apply_detected,
    app.marker_detail,
    (select c.relkind from pg_class c where c.oid = settings_oid) as settings_kind,
    (select c.relkind from pg_class c where c.oid = orders_oid) as orders_kind,
    (select c.relkind from pg_class c where c.oid = profiles_oid) as profiles_kind,
    (select c.relrowsecurity from pg_class c where c.oid = profiles_oid) as profiles_rls,
    (select c.relforcerowsecurity from pg_class c where c.oid = profiles_oid) as profiles_force_rls,
    (select count(*) from pg_policy p where p.polrelid = profiles_oid) as profiles_policy_count,
    coalesce(has_table_privilege('anon', profiles_oid, 'SELECT'), false)
      or coalesce(has_table_privilege('anon', profiles_oid, 'INSERT'), false)
      or coalesce(has_table_privilege('anon', profiles_oid, 'UPDATE'), false)
      or coalesce(has_table_privilege('anon', profiles_oid, 'DELETE'), false)
      or coalesce(has_table_privilege('authenticated', profiles_oid, 'SELECT'), false)
      or coalesce(has_table_privilege('authenticated', profiles_oid, 'INSERT'), false)
      or coalesce(has_table_privilege('authenticated', profiles_oid, 'UPDATE'), false)
      or coalesce(has_table_privilege('authenticated', profiles_oid, 'DELETE'), false)
      as profiles_browser_table_access,
    coalesce(has_any_column_privilege('anon', profiles_oid, 'SELECT'), false)
      or coalesce(has_any_column_privilege('anon', profiles_oid, 'INSERT'), false)
      or coalesce(has_any_column_privilege('anon', profiles_oid, 'UPDATE'), false)
      or coalesce(has_any_column_privilege('authenticated', profiles_oid, 'SELECT'), false)
      or coalesce(has_any_column_privilege('authenticated', profiles_oid, 'INSERT'), false)
      or coalesce(has_any_column_privilege('authenticated', profiles_oid, 'UPDATE'), false)
      as profiles_browser_column_access,
    (select c.relkind from pg_class c where c.oid = abuse_oid) as abuse_kind,
    (select c.relrowsecurity from pg_class c where c.oid = abuse_oid) as abuse_rls,
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'settings'
        and column_name = 'key' and data_type = 'text') as settings_key_columns,
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'settings'
        and column_name = 'value' and data_type = 'jsonb') as settings_value_columns,
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'orders'
        and column_name = 'payment_method') as payment_method_columns,
    exists (
      select 1
        from pg_index i
       where i.indrelid = settings_oid
         and i.indisunique
         and pg_get_indexdef(i.indexrelid) ~ '\(key\)'
    ) as settings_key_unique
  from object_contracts oc
  cross join application_state app
),
abuse_column_facts as (
  select
    f.*,
    (select count(*)
       from pg_attribute a
      where a.attrelid = abuse_oid and a.attnum > 0 and not a.attisdropped
    ) as abuse_column_count,
    (select count(*)
       from pg_attribute a
      where a.attrelid = abuse_oid and a.attname = 'scope'
        and format_type(a.atttypid, a.atttypmod) = 'text' and a.attnotnull
    ) = 1 as scope_column_compatible,
    (select count(*)
       from pg_attribute a
      where a.attrelid = abuse_oid and a.attname = 'fingerprint'
        and format_type(a.atttypid, a.atttypmod) = 'text' and a.attnotnull
    ) = 1 as fingerprint_column_compatible,
    (select count(*)
       from pg_attribute a
      where a.attrelid = abuse_oid and a.attname = 'window_started'
        and format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
        and a.attnotnull
    ) = 1 as window_column_compatible,
    (select count(*)
       from pg_attribute a
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = abuse_oid and a.attname = 'attempt_count'
        and format_type(a.atttypid, a.atttypmod) = 'integer' and a.attnotnull
        and regexp_replace(lower(pg_get_expr(d.adbin, d.adrelid)), '[[:space:]()]', '', 'g')
          in ('1', '1::integer')
    ) = 1 as attempt_column_compatible,
    (select count(*)
       from pg_attribute a
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = abuse_oid and a.attname = 'updated_at'
        and format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
        and a.attnotnull
        and regexp_replace(lower(pg_get_expr(d.adbin, d.adrelid)), '[[:space:]]', '', 'g')
          = 'clock_timestamp()'
    ) = 1 as updated_column_compatible,
    coalesce((
      select array(
        select a.attname::text
          from unnest(c.conkey) with ordinality as key_column(attnum, ordinal_position)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = key_column.attnum
         order by key_column.ordinal_position
      )
        from pg_constraint c
       where c.conrelid = abuse_oid and c.contype = 'p'
       limit 1
    ), '{}'::text[]) as abuse_primary_key_columns,
    (select count(*) from pg_constraint c
      where c.conrelid = abuse_oid and c.contype = 'p') as abuse_primary_key_count,
    (select regexp_replace(lower(pg_get_expr(c.conbin, c.conrelid)),
              '[[:space:]()]|::text', '', 'g')
       from pg_constraint c
      where c.conrelid = abuse_oid and c.contype = 'c'
        and c.conname = 'order_abuse_scope_check'
    ) as scope_check_expression,
    (select c.convalidated
       from pg_constraint c
      where c.conrelid = abuse_oid and c.contype = 'c'
        and c.conname = 'order_abuse_scope_check'
    ) as scope_check_validated,
    (select regexp_replace(lower(pg_get_expr(c.conbin, c.conrelid)),
              '[[:space:]()]|::text', '', 'g')
       from pg_constraint c
      where c.conrelid = abuse_oid and c.contype = 'c'
        and c.conname = 'order_abuse_fingerprint_check'
    ) as fingerprint_check_expression,
    (select c.convalidated
       from pg_constraint c
      where c.conrelid = abuse_oid and c.contype = 'c'
        and c.conname = 'order_abuse_fingerprint_check'
    ) as fingerprint_check_validated,
    (select regexp_replace(lower(pg_get_expr(c.conbin, c.conrelid)),
              '[[:space:]()]|::integer', '', 'g')
       from pg_constraint c
      where c.conrelid = abuse_oid and c.contype = 'c'
        and c.conname = 'order_abuse_attempt_count_positive'
    ) as attempt_check_expression,
    (select c.convalidated
       from pg_constraint c
      where c.conrelid = abuse_oid and c.contype = 'c'
        and c.conname = 'order_abuse_attempt_count_positive'
    ) as attempt_check_validated,
    coalesce(has_table_privilege('anon', abuse_oid, 'SELECT'), false)
      or coalesce(has_table_privilege('anon', abuse_oid, 'INSERT'), false)
      or coalesce(has_table_privilege('anon', abuse_oid, 'UPDATE'), false)
      or coalesce(has_table_privilege('anon', abuse_oid, 'DELETE'), false)
      or coalesce(has_table_privilege('authenticated', abuse_oid, 'SELECT'), false)
      or coalesce(has_table_privilege('authenticated', abuse_oid, 'INSERT'), false)
      or coalesce(has_table_privilege('authenticated', abuse_oid, 'UPDATE'), false)
      or coalesce(has_table_privilege('authenticated', abuse_oid, 'DELETE'), false)
      as abuse_browser_table_access,
    coalesce(has_any_column_privilege('anon', abuse_oid, 'SELECT'), false)
      or coalesce(has_any_column_privilege('anon', abuse_oid, 'INSERT'), false)
      or coalesce(has_any_column_privilege('anon', abuse_oid, 'UPDATE'), false)
      or coalesce(has_any_column_privilege('authenticated', abuse_oid, 'SELECT'), false)
      or coalesce(has_any_column_privilege('authenticated', abuse_oid, 'INSERT'), false)
      or coalesce(has_any_column_privilege('authenticated', abuse_oid, 'UPDATE'), false)
      as abuse_browser_column_access,
    coalesce(has_table_privilege('service_role', abuse_oid, 'SELECT'), false)
      and coalesce(has_table_privilege('service_role', abuse_oid, 'INSERT'), false)
      and coalesce(has_table_privilege('service_role', abuse_oid, 'UPDATE'), false)
      and coalesce(has_table_privilege('service_role', abuse_oid, 'DELETE'), false)
      and coalesce(has_table_privilege('service_role', abuse_oid, 'TRUNCATE'), false)
      and coalesce(has_table_privilege('service_role', abuse_oid, 'REFERENCES'), false)
      and coalesce(has_table_privilege('service_role', abuse_oid, 'TRIGGER'), false)
      as abuse_service_role_all_access
  from object_facts f
),
abuse_contract_facts as (
  select
    f.*,
    abuse_oid is not null
      and abuse_kind = 'r'
      and abuse_column_count = 5
      and scope_column_compatible
      and fingerprint_column_compatible
      and window_column_compatible
      and attempt_column_compatible
      and updated_column_compatible
      and abuse_primary_key_count = 1
      and abuse_primary_key_columns = array['scope', 'fingerprint', 'window_started']::text[]
      and scope_check_validated
      and scope_check_expression = 'scope=anyarray[''ip'',''phone'',''checkout'']'
      and fingerprint_check_validated
      and fingerprint_check_expression = 'fingerprint~''^[0-9a-f]{64}$'''
      and attempt_check_validated
      and attempt_check_expression = 'attempt_count>0'
      and abuse_rls
      and not abuse_browser_table_access
      and not abuse_browser_column_access
      and abuse_service_role_all_access as abuse_table_compatible
  from abuse_column_facts f
),
abuse_index_facts as (
  select
    f.*,
    ic.relkind as abuse_index_kind,
    am.amname as abuse_index_method,
    i.indisvalid as abuse_index_valid,
    i.indisready as abuse_index_ready,
    i.indisunique as abuse_index_unique,
    i.indpred is not null as abuse_index_partial,
    i.indexprs is not null as abuse_index_expression,
    i.indnkeyatts as abuse_index_key_count,
    i.indnatts as abuse_index_attribute_count,
    key_attribute.attname as abuse_index_key_column,
    abuse_index_oid is not null
      and ic.relkind = 'i'
      and i.indrelid = abuse_oid
      and am.amname = 'btree'
      and i.indisvalid and i.indisready and not i.indisunique
      and i.indpred is null and i.indexprs is null
      and i.indnkeyatts = 1 and i.indnatts = 1
      and key_attribute.attname = 'updated_at' as abuse_index_compatible
  from abuse_contract_facts f
  left join pg_class ic on ic.oid = abuse_index_oid
  left join pg_index i on i.indexrelid = abuse_index_oid
  left join pg_am am on am.oid = ic.relam
  left join pg_attribute key_attribute
    on key_attribute.attrelid = i.indrelid and key_attribute.attnum = i.indkey[0]
),
required_object_checks as (
  select 'required_object_contract'::text as check_name, subject, status, detail
  from abuse_index_facts
  cross join lateral (values
    (
      'public.settings'::text,
      case when settings_oid is not null and settings_kind in ('r', 'p')
                     and settings_key_columns = 1 and settings_value_columns = 1
                     and settings_key_unique
           then 'PASS' else 'BLOCKED' end,
      jsonb_build_object(
        'exists', settings_oid is not null,
        'relation_kind', settings_kind,
        'text_key_column', settings_key_columns = 1,
        'jsonb_value_column', settings_value_columns = 1,
        'unique_key', settings_key_unique
      )::text
    ),
    (
      'public.orders.payment_method'::text,
      case when orders_oid is not null and orders_kind in ('r', 'p')
                     and payment_method_columns = 1
           then 'PASS' else 'BLOCKED' end,
      jsonb_build_object(
        'orders_exists', orders_oid is not null,
        'relation_kind', orders_kind,
        'payment_method_column', payment_method_columns = 1
      )::text
    ),
    (
      'public.profiles'::text,
      case when profiles_oid is null then 'PASS'
           when profiles_kind not in ('r', 'p') then 'BLOCKED'
           when post_apply_detected and profiles_rls and profiles_force_rls
                and profiles_policy_count = 0
                and not profiles_browser_table_access
                and not profiles_browser_column_access then 'PASS'
           when post_apply_detected then 'BLOCKED'
           else 'WARNING'
      end,
      jsonb_build_object(
        'exists', profiles_oid is not null,
        'relation_kind', profiles_kind,
        'rls_enabled', profiles_rls,
        'force_rls', profiles_force_rls,
        'policy_count', profiles_policy_count,
        'browser_table_access', profiles_browser_table_access,
        'browser_column_access', profiles_browser_column_access,
        'post_apply_detected', post_apply_detected,
        'application_markers', marker_detail
      )::text
    ),
    (
      'public.order_abuse_counters'::text,
      case
        when abuse_oid is null and post_apply_detected then 'BLOCKED'
        when abuse_oid is null then 'PASS'
        when abuse_table_compatible is not true then 'BLOCKED'
        when post_apply_detected then 'PASS'
        else 'WARNING'
      end,
      jsonb_build_object(
        'exists', abuse_oid is not null,
        'post_apply_detected', post_apply_detected,
        'already_applied_or_partial_state', abuse_oid is not null and abuse_table_compatible is true
          and not post_apply_detected,
        'compatible', abuse_table_compatible,
        'relation_kind', abuse_kind,
        'column_count', abuse_column_count,
        'columns', jsonb_build_object(
          'scope', scope_column_compatible,
          'fingerprint', fingerprint_column_compatible,
          'window_started', window_column_compatible,
          'attempt_count', attempt_column_compatible,
          'updated_at', updated_column_compatible
        ),
        'primary_key_count', abuse_primary_key_count,
        'primary_key_columns', abuse_primary_key_columns,
        'checks', jsonb_build_object(
          'scope', jsonb_build_object('validated', scope_check_validated, 'expression', scope_check_expression),
          'fingerprint', jsonb_build_object('validated', fingerprint_check_validated, 'expression', fingerprint_check_expression),
          'attempt_count', jsonb_build_object('validated', attempt_check_validated, 'expression', attempt_check_expression)
        ),
        'rls_enabled', abuse_rls,
        'browser_table_access', abuse_browser_table_access,
        'browser_column_access', abuse_browser_column_access,
        'service_role_all_access', abuse_service_role_all_access,
        'application_markers', marker_detail
      )::text
    ),
    (
      'public.order_abuse_counters_updated_at_idx'::text,
      case
        when abuse_index_oid is null and post_apply_detected then 'BLOCKED'
        when abuse_index_oid is null then 'PASS'
        when abuse_index_compatible is not true then 'BLOCKED'
        when post_apply_detected then 'PASS'
        else 'WARNING'
      end,
      jsonb_build_object(
        'exists', abuse_index_oid is not null,
        'post_apply_detected', post_apply_detected,
        'already_applied_or_partial_state', abuse_index_oid is not null
          and abuse_index_compatible is true and not post_apply_detected,
        'compatible', abuse_index_compatible,
        'relation_kind', abuse_index_kind,
        'table_matches', abuse_oid is not null,
        'access_method', abuse_index_method,
        'valid', abuse_index_valid,
        'ready', abuse_index_ready,
        'unique', abuse_index_unique,
        'partial', abuse_index_partial,
        'expression', abuse_index_expression,
        'key_count', abuse_index_key_count,
        'attribute_count', abuse_index_attribute_count,
        'key_column', abuse_index_key_column,
        'application_markers', marker_detail
      )::text
    )
  ) as checks(subject, status, detail)
),

-- 2. Existing profile policies. Every returned row is removed by the migration.
profile_policy_rows as (
  select
    pol.polname,
    pol.polcmd,
    pol.polpermissive,
    pg_get_expr(pol.polqual, pol.polrelid) as using_expression,
    pg_get_expr(pol.polwithcheck, pol.polrelid) as check_expression,
    array(
      select case when role_oid = 0 then 'PUBLIC' else r.rolname end
        from unnest(pol.polroles) as u(role_oid)
        left join pg_roles r on r.oid = role_oid
       order by case when role_oid = 0 then 'PUBLIC' else r.rolname end
    ) as roles
  from pg_policy pol
  where pol.polrelid = to_regclass('public.profiles')
),
profile_policy_checks as (
  select
    'profile_policy'::text as check_name,
    polname::text as subject,
    case when app.post_apply_detected then 'BLOCKED' else 'WARNING' end::text as status,
    jsonb_build_object(
      'command', polcmd,
      'permissive', polpermissive,
      'roles', roles,
      'using', using_expression,
      'with_check', check_expression
    )::text as detail
  from profile_policy_rows
  cross join application_state app
  union all
  select 'profile_policy', 'none', 'PASS', '{"count":0}'
  where not exists (select 1 from profile_policy_rows)
),

-- 3. Existing browser-role table grants on profiles.
profile_grant_rows as (
  select grantee, privilege_type, is_grantable
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'profiles'
     and grantee in ('PUBLIC', 'anon', 'authenticated')
),
profile_grant_checks as (
  select
    'profile_browser_grant'::text as check_name,
    (grantee || ':' || privilege_type)::text as subject,
    case when app.post_apply_detected then 'BLOCKED' else 'WARNING' end::text as status,
    jsonb_build_object(
      'grantee', grantee,
      'privilege', privilege_type,
      'grantable', is_grantable
    )::text as detail
  from profile_grant_rows
  cross join application_state app
  union all
  select 'profile_browser_grant', 'none', 'PASS', '{"count":0}'
  where not exists (select 1 from profile_grant_rows)
),

-- 4. Existing column-level profile grants.
profile_column_grant_rows as (
  select grantee, column_name, privilege_type, is_grantable
    from information_schema.column_privileges
   where table_schema = 'public'
     and table_name = 'profiles'
     and grantee in ('PUBLIC', 'anon', 'authenticated')
),
profile_column_grant_checks as (
  select
    'profile_browser_column_grant'::text as check_name,
    (grantee || ':' || column_name || ':' || privilege_type)::text as subject,
    case when app.post_apply_detected then 'BLOCKED' else 'WARNING' end::text as status,
    jsonb_build_object(
      'grantee', grantee,
      'column', column_name,
      'privilege', privilege_type,
      'grantable', is_grantable
    )::text as detail
  from profile_column_grant_rows
  cross join application_state app
  union all
  select 'profile_browser_column_grant', 'none', 'PASS', '{"count":0}'
  where not exists (select 1 from profile_column_grant_rows)
),

-- 5. Legacy helper definitions, SECURITY DEFINER state, search_path, and grants.
expected_legacy_helpers(name) as (
  values ('is_admin'::text), ('handle_new_user'::text)
),
legacy_helper_rows as (
  select
    p.oid,
    p.oid::regprocedure::text as identity,
    p.proname,
    p.pronargs,
    p.prosecdef,
    l.lanname as language_name,
    p.proacl::text as acl,
    p.prosrc,
    lower(regexp_replace(p.prosrc, '\s+', '', 'g')) as compact_body,
    pg_get_function_result(p.oid) as result_type,
    pg_get_functiondef(p.oid) as definition,
    coalesce((
      select setting
        from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg(setting)
       where setting like 'search_path=%'
       limit 1
    ), '') as configured_search_path,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and p.proname in ('is_admin', 'handle_new_user')
),
classified_legacy_helpers as (
  select
    *,
    case
      when proname = 'is_admin'
       and pronargs = 0
       and result_type = 'boolean'
       and strpos(compact_body, 'frompublic.profiles') > 0
       and strpos(compact_body, 'auth.uid()') > 0
       and strpos(compact_body, 'execute') = 0 then true
      when proname = 'handle_new_user'
       and pronargs = 0
       and result_type = 'trigger'
       and strpos(compact_body, 'insertintopublic.profiles') > 0
       and strpos(compact_body, 'returnnew') > 0
       and strpos(compact_body, 'execute') = 0 then true
      else false
    end as repository_compatible
  from legacy_helper_rows
),
legacy_helper_checks as (
  select
    'legacy_helper_definition'::text as check_name,
    c.identity::text as subject,
    case
      when not c.repository_compatible or not c.prosecdef or c.language_name <> 'plpgsql'
        then 'CANNOT_VERIFY'
      when c.configured_search_path = 'search_path=pg_catalog, public'
           and not c.anon_execute and not c.authenticated_execute
        then 'PASS'
      else 'WARNING'
    end::text as status,
    jsonb_build_object(
      'security_definer', c.prosecdef,
      'language', c.language_name,
      'result_type', c.result_type,
      'search_path', nullif(c.configured_search_path, ''),
      'repository_compatible', c.repository_compatible,
      'anon_execute', c.anon_execute,
      'authenticated_execute', c.authenticated_execute,
      'acl', c.acl,
      'definition', c.definition
    )::text as detail
  from classified_legacy_helpers c
  union all
  select
    'legacy_helper_definition',
    'public.' || e.name || '()',
    'PASS',
    '{"exists":false}'
  from expected_legacy_helpers e
  where not exists (
    select 1 from legacy_helper_rows h where h.proname = e.name
  )
),

-- 6. Trigger dependencies on handle_new_user.
handle_new_user_trigger_rows as (
  select
    tn.nspname as table_schema,
    tc.relname as table_name,
    t.tgname,
    t.tgenabled,
    p.oid::regprocedure::text as helper_identity,
    pg_get_triggerdef(t.oid, true) as trigger_definition
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  join pg_namespace pn on pn.oid = p.pronamespace
  join pg_class tc on tc.oid = t.tgrelid
  join pg_namespace tn on tn.oid = tc.relnamespace
  where not t.tgisinternal
    and pn.nspname = 'public'
    and p.proname = 'handle_new_user'
),
handle_new_user_trigger_checks as (
  select
    'handle_new_user_trigger_dependency'::text as check_name,
    (table_schema || '.' || table_name || ':' || tgname)::text as subject,
    case when table_schema = 'auth' and table_name = 'users'
         then 'WARNING' else 'CANNOT_VERIFY' end::text as status,
    jsonb_build_object(
      'enabled', tgenabled,
      'helper', helper_identity,
      'definition', trigger_definition
    )::text as detail
  from handle_new_user_trigger_rows
  union all
  select 'handle_new_user_trigger_dependency', 'none', 'PASS', '{"count":0}'
  where not exists (select 1 from handle_new_user_trigger_rows)
),

-- 7. Payment setting values and types.
expected_payment_settings(key, migration_default) as (
  values ('cod'::text, true), ('instapay'::text, false)
),
payment_setting_rows as (
  select
    e.key,
    e.migration_default,
    s.key is not null as row_exists,
    s.value,
    jsonb_typeof(s.value) as value_type
  from expected_payment_settings e
  left join public.settings s on s.key = e.key
),
payment_setting_checks as (
  select
    'payment_setting'::text as check_name,
    key::text as subject,
    case when not row_exists then 'WARNING'
         when value_type = 'boolean' then 'PASS'
         else 'WARNING' end::text as status,
    jsonb_build_object(
      'exists', row_exists,
      'stored_type', value_type,
      'stored_value', value,
      'migration_default', migration_default,
      'effective_enabled', case
        when value_type = 'boolean' then (value #>> '{}')::boolean
        when not row_exists then migration_default
        else false
      end
    )::text as detail
  from payment_setting_rows
),

-- 8. Current historical payment-method values.
historical_payment_rows as (
  select payment_method, count(*)::bigint as row_count
    from public.orders
   group by payment_method
),
historical_payment_checks as (
  select
    'historical_payment_method'::text as check_name,
    coalesce(payment_method, '<NULL>')::text as subject,
    case when payment_method in ('COD', 'InstaPay')
         then 'PASS' else 'WARNING' end::text as status,
    jsonb_build_object(
      'row_count', row_count,
      'allowed_for_new_or_changed_rows', payment_method in ('COD', 'InstaPay')
    )::text as detail
  from historical_payment_rows
  union all
  select 'historical_payment_method', 'none', 'PASS', '{"row_count":0}'
  where not exists (select 1 from historical_payment_rows)
),

-- 9. Database functions that appear to assign orders.payment_method.
payment_method_workflow_rows as (
  select
    p.oid::regprocedure::text as identity,
    pg_get_functiondef(p.oid) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname <> 'information_schema'
    and n.nspname !~ '^pg_'
    and regexp_replace(p.prosrc, '\s+', ' ', 'g') ~* 'update (public\.)?orders'
    and regexp_replace(p.prosrc, '\s+', ' ', 'g')
      ~* '(set|,)[[:space:]]*payment_method[[:space:]]*='
),
payment_method_workflow_checks as (
  select
    'payment_method_update_workflow'::text as check_name,
    identity::text as subject,
    'CANNOT_VERIFY'::text as status,
    jsonb_build_object('definition', definition)::text as detail
  from payment_method_workflow_rows
  union all
  select
    'payment_method_update_workflow',
    'none detected',
    'PASS',
    '{"trigger_scope":"INSERT OR UPDATE OF payment_method only"}'
  where not exists (select 1 from payment_method_workflow_rows)
),

-- 10. Existing payment trigger with the migration's name.
preview_payment_trigger_rows as (
  select
    t.tgname,
    t.tgenabled,
    t.tgtype::integer as trigger_type,
    t.tgfoid,
    t.tgattr[0] as update_column_number,
    guard.oid as expected_function_oid,
    payment_method.attnum as expected_update_column_number,
    pg_get_triggerdef(t.oid, true) as definition,
    t.tgenabled = 'O'
      and t.tgtype::integer = 23
      and t.tgfoid = guard.oid
      and t.tgattr[0] = payment_method.attnum as repository_compatible
  from pg_trigger t
  cross join lateral (
    select to_regprocedure('public.enforce_preview_payment_method()') as oid
  ) guard
  left join pg_attribute payment_method
    on payment_method.attrelid = t.tgrelid
   and payment_method.attname = 'payment_method'
   and not payment_method.attisdropped
  where t.tgrelid = to_regclass('public.orders')
    and t.tgname = 'enforce_preview_payment_method'
    and not t.tgisinternal
),
preview_payment_trigger_checks as (
  select
    'preview_payment_trigger_name'::text as check_name,
    tgname::text as subject,
    case
      when repository_compatible is not true then 'BLOCKED'
      when app.post_apply_detected then 'PASS'
      else 'WARNING'
    end::text as status,
    jsonb_build_object(
      'post_apply_detected', app.post_apply_detected,
      'already_applied_or_partial_state', repository_compatible is true
        and not app.post_apply_detected,
      'compatible', repository_compatible,
      'enabled_mode', tgenabled,
      'trigger_type', trigger_type,
      'expected_trigger_type', 23,
      'function_matches', tgfoid = expected_function_oid,
      'update_column_matches', update_column_number = expected_update_column_number,
      'definition', definition,
      'application_markers', app.marker_detail
    )::text as detail
  from preview_payment_trigger_rows
  cross join application_state app
  union all
  select
    'preview_payment_trigger_name',
    'not installed',
    case when app.post_apply_detected then 'BLOCKED' else 'PASS' end,
    jsonb_build_object(
      'exists', false,
      'expected_before_migration', not app.post_apply_detected,
      'post_apply_detected', app.post_apply_detected,
      'application_markers', app.marker_detail
    )::text
  from application_state app
  where not exists (select 1 from preview_payment_trigger_rows)
),

-- 11. Exact identities and current grants for new/protected RPCs.
expected_protected_rpcs(name, identity, result_type) as (
  values
    ('consume_order_abuse_limits', 'public.consume_order_abuse_limits(text,text,text)', 'jsonb'),
    ('create_preview_order_with_stock', 'public.create_preview_order_with_stock(jsonb,jsonb,text)', 'jsonb'),
    ('enforce_preview_payment_method', 'public.enforce_preview_payment_method()', 'trigger'),
    ('create_order_with_stock', 'public.create_order_with_stock(jsonb,jsonb)', 'jsonb')
),
resolved_protected_rpcs as (
  select e.*, to_regprocedure(e.identity) as oid
  from expected_protected_rpcs e
),
protected_rpc_rows as (
  select
    r.*,
    p.prosecdef,
    l.lanname as language_name,
    p.proacl::text as acl,
    lower(regexp_replace(p.prosrc, '[[:space:]]+', '', 'g')) as compact_body,
    pg_get_functiondef(p.oid) as definition,
    pg_get_function_result(p.oid) as actual_result_type,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
    coalesce((
      select setting
        from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg(setting)
       where setting like 'search_path=%'
       limit 1
    ), '') as configured_search_path
  from resolved_protected_rpcs r
  left join pg_proc p on p.oid = r.oid
  left join pg_language l on l.oid = p.prolang
),
classified_protected_rpcs as (
  select
    r.*,
    case
      when name = 'consume_order_abuse_limits' then
        oid is not null
        and actual_result_type = result_type
        and prosecdef and language_name = 'plpgsql'
        and configured_search_path = 'search_path=pg_catalog, public, pg_temp'
        and not anon_execute and not authenticated_execute and service_role_execute
        and strpos(compact_body, 'invalid_abuse_fingerprint') > 0
        and strpos(compact_body, 'deletefrompublic.order_abuse_counters') > 0
        and strpos(compact_body, 'interval''24hours''') > 0
        and strpos(compact_body, '(''ip''::text,p_ip_hash,interval''10minutes'',5)') > 0
        and strpos(compact_body, '(''phone''::text,p_phone_hash,interval''30minutes'',3)') > 0
        and strpos(compact_body, '(''checkout''::text,p_checkout_hash,interval''30minutes'',3)') > 0
        and strpos(compact_body, 'onconflict(scope,fingerprint,window_started)doupdate') > 0
        and strpos(compact_body, 'attempt_count=public.order_abuse_counters.attempt_count+1') > 0
        and strpos(compact_body, 'ifv_attempt_count>v_rule.attempt_limitthen') > 0
        and strpos(compact_body, '''allowed'',false') > 0
        and strpos(compact_body, '''allowed'',true') > 0
      when name = 'create_preview_order_with_stock' then
        oid is not null
        and actual_result_type = result_type
        and prosecdef and language_name = 'plpgsql'
        and configured_search_path = 'search_path=pg_catalog, public, pg_temp'
        and not anon_execute and not authenticated_execute and service_role_execute
        and strpos(compact_body, 'invalid_order_data') > 0
        and strpos(compact_body, 'pg_advisory_xact_lock(hashtextextended(v_checkout_token,0))') > 0
        and strpos(compact_body, 'frompublic.orderswherecheckout_token=v_checkout_token') > 0
        and strpos(compact_body, 'iffoundthenreturnpublic.create_order_with_stock(p_order,p_items);') > 0
        and strpos(compact_body, 'jsonb_typeof(v_setting)') > 0
        and strpos(compact_body, 'payment_method_disabled') > 0
        and strpos(compact_body, 'pg_advisory_xact_lock(hashtextextended(p_phone_hash,0))') > 0
        and strpos(compact_body, 'v_active_cod_count>=2') > 0
        and strpos(compact_body, 'cod_active_order_limit') > 0
        and strpos(compact_body, 'returnpublic.create_order_with_stock(p_order,p_items);') > 0
      when name = 'enforce_preview_payment_method' then
        oid is not null
        and actual_result_type = result_type
        and not prosecdef and language_name = 'plpgsql'
        and configured_search_path = 'search_path=pg_catalog, public'
        and not anon_execute and not authenticated_execute
        and strpos(compact_body, 'new.payment_methodnotin(''cod'',''instapay'')') > 0
        and strpos(compact_body, 'invalid_payment_method') > 0
        and strpos(compact_body, 'returnnew;') > 0
      when name = 'create_order_with_stock' then
        oid is not null
        and actual_result_type = result_type
        and not anon_execute and not authenticated_execute
      else false
    end as repository_compatible
  from protected_rpc_rows r
),
protected_rpc_checks as (
  select
    'protected_rpc_contract'::text as check_name,
    identity::text as subject,
    case
      when name = 'create_order_with_stock' and repository_compatible is not true then 'BLOCKED'
      when name = 'create_order_with_stock' then 'PASS'
      when oid is null and app.post_apply_detected then 'BLOCKED'
      when oid is null then 'PASS'
      when repository_compatible is not true then 'BLOCKED'
      when app.post_apply_detected then 'PASS'
      else 'WARNING'
    end::text as status,
    jsonb_build_object(
      'exists', oid is not null,
      'post_apply_detected', app.post_apply_detected,
      'already_applied_or_partial_state', oid is not null
        and repository_compatible is true and not app.post_apply_detected,
      'repository_compatible', repository_compatible,
      'expected_result', result_type,
      'actual_result', actual_result_type,
      'security_definer', prosecdef,
      'language', language_name,
      'search_path', nullif(configured_search_path, ''),
      'anon_execute', anon_execute,
      'authenticated_execute', authenticated_execute,
      'service_role_execute', service_role_execute,
      'acl', acl,
      'definition', definition,
      'application_markers', app.marker_detail
    )::text as detail
  from classified_protected_rpcs
  cross join application_state app
),

-- 12. Unexpected overloads with protected names.
expected_protected_rpc_oids(oid) as (
  values
    (to_regprocedure('public.consume_order_abuse_limits(text,text,text)')),
    (to_regprocedure('public.create_preview_order_with_stock(jsonb,jsonb,text)')),
    (to_regprocedure('public.enforce_preview_payment_method()')),
    (to_regprocedure('public.create_order_with_stock(jsonb,jsonb)'))
),
unexpected_protected_rpc_rows as (
  select p.oid::regprocedure::text as identity
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'consume_order_abuse_limits',
       'create_preview_order_with_stock',
       'enforce_preview_payment_method',
       'create_order_with_stock'
     )
     and not exists (
       select 1 from expected_protected_rpc_oids e where e.oid = p.oid
     )
),
unexpected_protected_rpc_checks as (
  select
    'unexpected_protected_rpc_overload'::text as check_name,
    identity::text as subject,
    'BLOCKED'::text as status,
    '{"requires_manual_review":true}'::text as detail
  from unexpected_protected_rpc_rows
  union all
  select 'unexpected_protected_rpc_overload', 'none', 'PASS', '{"count":0}'
  where not exists (select 1 from unexpected_protected_rpc_rows)
),

all_checks as (
  select check_name, subject, status, detail from required_object_checks
  union all
  select check_name, subject, status, detail from profile_policy_checks
  union all
  select check_name, subject, status, detail from profile_grant_checks
  union all
  select check_name, subject, status, detail from profile_column_grant_checks
  union all
  select check_name, subject, status, detail from legacy_helper_checks
  union all
  select check_name, subject, status, detail from handle_new_user_trigger_checks
  union all
  select check_name, subject, status, detail from payment_setting_checks
  union all
  select check_name, subject, status, detail from historical_payment_checks
  union all
  select check_name, subject, status, detail from payment_method_workflow_checks
  union all
  select check_name, subject, status, detail from preview_payment_trigger_checks
  union all
  select check_name, subject, status, detail from protected_rpc_checks
  union all
  select check_name, subject, status, detail from unexpected_protected_rpc_checks
),
summary_counts as (
  select
    count(*) filter (where status = 'PASS')::bigint as pass,
    count(*) filter (where status = 'WARNING')::bigint as warning,
    count(*) filter (where status = 'BLOCKED')::bigint as blocked,
    count(*) filter (where status = 'CANNOT_VERIFY')::bigint as cannot_verify
  from all_checks
),
final_rows as (
  select check_name, subject, status, detail from all_checks
  union all
  select
    'overall_preview_security_preflight'::text as check_name,
    'summary'::text as subject,
    case
      when blocked > 0 then 'BLOCKED'
      when cannot_verify > 0 then 'CANNOT_VERIFY'
      when warning > 0 then 'WARNING'
      else 'PASS'
    end::text as status,
    jsonb_build_object(
      'pass', pass,
      'warning', warning,
      'blocked', blocked,
      'cannot_verify', cannot_verify
    )::text as detail
  from summary_counts
)
select check_name, subject, status, detail
from final_rows
order by
  case when check_name = 'overall_preview_security_preflight' then 1 else 0 end,
  check_name,
  subject;

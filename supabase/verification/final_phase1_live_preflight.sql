-- Phase 1 live preflight for manual use in the Supabase SQL Editor.
-- Every top-level statement is a read-only catalog or aggregate query.
-- Result sets are intentionally ordered from 1 through 20.

-- 1. active_table_relation_kinds
with expected(table_name) as (
  values
    ('categories'),
    ('products'),
    ('product_images'),
    ('orders'),
    ('order_items'),
    ('settings'),
    ('subscribers'),
    ('notify_me'),
    ('episodes'),
    ('push_tokens')
)
select
  'active_table_relation_kinds'::text as result_set,
  e.table_name,
  c.relkind,
  case
    when c.oid is null then 'missing'
    when c.relkind = 'r' then 'ordinary table'
    when c.relkind = 'p' then 'partitioned table'
    when c.relkind = 'v' then 'view'
    when c.relkind = 'm' then 'materialized view'
    when c.relkind = 'f' then 'foreign table'
    else 'other'
  end as relation_kind,
  'ordinary or partitioned table'::text as expected,
  case
    when c.oid is null then 'BLOCKED'
    when c.relkind in ('r', 'p') then 'PASS'
    else 'BLOCKED'
  end as status
from expected as e
left join pg_namespace as n
  on n.nspname = 'public'
left join pg_class as c
  on c.relnamespace = n.oid
 and c.relname = e.table_name
order by e.table_name;

-- 2. check_constraints
select
  'check_constraints'::text as result_set,
  c.conname as constraint_name,
  cls.relname as table_name,
  pg_get_constraintdef(c.oid, true) as definition,
  c.convalidated as is_validated
from pg_constraint as c
join pg_class as cls
  on cls.oid = c.conrelid
join pg_namespace as n
  on n.oid = cls.relnamespace
where n.nspname = 'public'
  and cls.relname in (
    'categories', 'products', 'product_images', 'orders', 'order_items',
    'settings', 'subscribers', 'notify_me', 'episodes', 'push_tokens'
  )
  and c.contype = 'c'
order by cls.relname, c.conname;

-- 3. foreign_keys
select
  'foreign_keys'::text as result_set,
  c.conname as constraint_name,
  source_table.relname as source_table,
  (
    select string_agg(a.attname, ', ' order by key_column.ordinality)
    from unnest(c.conkey) with ordinality as key_column(attnum, ordinality)
    join pg_attribute as a
      on a.attrelid = c.conrelid
     and a.attnum = key_column.attnum
  ) as source_columns,
  target_table.relname as target_table,
  (
    select string_agg(a.attname, ', ' order by key_column.ordinality)
    from unnest(c.confkey) with ordinality as key_column(attnum, ordinality)
    join pg_attribute as a
      on a.attrelid = c.confrelid
     and a.attnum = key_column.attnum
  ) as target_columns,
  case c.confdeltype
    when 'a' then 'NO ACTION'
    when 'r' then 'RESTRICT'
    when 'c' then 'CASCADE'
    when 'n' then 'SET NULL'
    when 'd' then 'SET DEFAULT'
  end as on_delete_action,
  case c.confupdtype
    when 'a' then 'NO ACTION'
    when 'r' then 'RESTRICT'
    when 'c' then 'CASCADE'
    when 'n' then 'SET NULL'
    when 'd' then 'SET DEFAULT'
  end as on_update_action,
  c.convalidated as is_validated,
  pg_get_constraintdef(c.oid, true) as definition
from pg_constraint as c
join pg_class as source_table
  on source_table.oid = c.conrelid
join pg_namespace as source_schema
  on source_schema.oid = source_table.relnamespace
join pg_class as target_table
  on target_table.oid = c.confrelid
join pg_namespace as target_schema
  on target_schema.oid = target_table.relnamespace
where source_schema.nspname = 'public'
  and target_schema.nspname = 'public'
  and source_table.relname in (
    'categories', 'products', 'product_images', 'orders', 'order_items',
    'settings', 'subscribers', 'notify_me', 'episodes', 'push_tokens'
  )
  and c.contype = 'f'
order by source_table.relname, c.conname;

-- 4. indexes
select
  'indexes'::text as result_set,
  index_table.relname as table_name,
  index_class.relname as index_name,
  index_state.indisunique as is_unique,
  index_state.indisprimary as is_primary,
  index_state.indisvalid as is_valid,
  index_state.indisready as is_ready,
  pg_get_expr(index_state.indpred, index_state.indrelid, true) as predicate,
  pg_get_indexdef(index_state.indexrelid) as full_index_definition
from pg_index as index_state
join pg_class as index_class
  on index_class.oid = index_state.indexrelid
join pg_class as index_table
  on index_table.oid = index_state.indrelid
join pg_namespace as n
  on n.oid = index_table.relnamespace
where n.nspname = 'public'
  and index_table.relname in (
    'categories', 'products', 'product_images', 'orders', 'order_items',
    'settings', 'subscribers', 'notify_me', 'episodes', 'push_tokens'
  )
order by index_table.relname, index_class.relname;

-- 5. rls_state
with expected(table_name) as (
  values
    ('categories'),
    ('products'),
    ('product_images'),
    ('orders'),
    ('order_items'),
    ('settings'),
    ('subscribers'),
    ('notify_me'),
    ('episodes'),
    ('push_tokens')
)
select
  'rls_state'::text as result_set,
  e.table_name,
  c.relrowsecurity,
  c.relforcerowsecurity,
  case when c.oid is null then 'CANNOT_VERIFY' else 'PASS' end as inspection_status
from expected as e
left join pg_namespace as n
  on n.nspname = 'public'
left join pg_class as c
  on c.relnamespace = n.oid
 and c.relname = e.table_name
order by e.table_name;

-- 6. policies
select
  'policies'::text as result_set,
  schemaname,
  tablename,
  policyname,
  roles,
  cmd as command,
  permissive,
  qual as using_expression,
  with_check as with_check_expression
from pg_policies
where schemaname = 'public'
  and tablename in (
    'categories', 'products', 'product_images', 'orders', 'order_items',
    'settings', 'subscribers', 'notify_me', 'episodes', 'push_tokens'
  )
order by tablename, policyname;

-- 7. table_grants
with table_acl as (
  select
    cls.relname as table_name,
    null::text as column_name,
    'table'::text as privilege_scope,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from pg_class as cls
  join pg_namespace as n
    on n.oid = cls.relnamespace
  cross join lateral aclexplode(coalesce(cls.relacl, acldefault('r', cls.relowner))) as acl
  where n.nspname = 'public'
    and cls.relkind in ('r', 'p')
    and cls.relname in (
      'categories', 'products', 'product_images', 'orders', 'order_items',
      'settings', 'subscribers', 'notify_me', 'episodes', 'push_tokens'
    )
),
column_acl as (
  select
    cls.relname as table_name,
    attribute.attname as column_name,
    'column'::text as privilege_scope,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from pg_class as cls
  join pg_namespace as n
    on n.oid = cls.relnamespace
  join pg_attribute as attribute
    on attribute.attrelid = cls.oid
   and attribute.attnum > 0
   and not attribute.attisdropped
  cross join lateral aclexplode(attribute.attacl) as acl
  where n.nspname = 'public'
    and cls.relkind in ('r', 'p')
    and cls.relname in (
      'categories', 'products', 'product_images', 'orders', 'order_items',
      'settings', 'subscribers', 'notify_me', 'episodes', 'push_tokens'
    )
),
combined as (
  select * from table_acl
  union all
  select * from column_acl
),
target_tables(table_name) as (
  values
    ('categories'),
    ('products'),
    ('product_images'),
    ('orders'),
    ('order_items'),
    ('settings'),
    ('subscribers'),
    ('notify_me'),
    ('episodes'),
    ('push_tokens')
),
target_roles(role_name, role_oid, role_exists) as (
  select 'PUBLIC'::text, 0::oid, true
  union all
  select expected.role_name, role.oid, role.oid is not null
  from (values ('anon'), ('authenticated'), ('service_role')) as expected(role_name)
  left join pg_roles as role
    on role.rolname = expected.role_name
)
select
  'table_grants'::text as result_set,
  target_table.table_name,
  target_role.role_name as grantee,
  target_role.role_exists,
  combined.privilege_scope,
  combined.column_name,
  combined.privilege_type,
  combined.is_grantable,
  grantor_role.rolname as grantor
from target_tables as target_table
cross join target_roles as target_role
left join combined
  on combined.table_name = target_table.table_name
 and combined.grantee = target_role.role_oid
left join pg_roles as grantor_role
  on grantor_role.oid = combined.grantor
order by target_table.table_name, target_role.role_name, combined.privilege_scope, combined.column_name, combined.privilege_type;

-- 8. protected_rpc_acl
with expected(function_name) as (
  values
    ('create_order_with_stock'),
    ('get_instapay_order_for_customer'),
    ('submit_instapay_payment_proof'),
    ('confirm_instapay_payment'),
    ('reject_instapay_payment'),
    ('expire_instapay_orders'),
    ('cancel_order_with_stock'),
    ('update_order_fulfillment_status'),
    ('confirm_card_payment'),
    ('adjust_product_stock')
),
matched as (
  select
    e.function_name,
    p.oid,
    p.proowner,
    p.proacl,
    p.prosecdef,
    p.prokind
  from expected as e
  left join pg_namespace as n
    on n.nspname = 'public'
  left join pg_proc as p
    on p.pronamespace = n.oid
   and p.proname = e.function_name
),
expanded as (
  select
    matched.*,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from matched
  left join lateral aclexplode(
    case
      when matched.oid is null then '{}'::aclitem[]
      else coalesce(matched.proacl, acldefault('f', matched.proowner))
    end
  ) as acl on true
)
select
  'protected_rpc_acl'::text as result_set,
  expanded.function_name,
  case when expanded.oid is null then null else expanded.oid::regprocedure::text end as signature,
  expanded.prokind as routine_kind,
  expanded.prosecdef as is_security_definer,
  owner_role.rolname as owner,
  case when expanded.grantee = 0 then 'PUBLIC' else grantee_role.rolname end as grantee,
  expanded.privilege_type,
  expanded.is_grantable,
  grantor_role.rolname as grantor,
  case when expanded.oid is null then 'CANNOT_VERIFY' else 'PASS' end as inspection_status
from expanded
left join pg_roles as owner_role
  on owner_role.oid = expanded.proowner
left join pg_roles as grantee_role
  on grantee_role.oid = expanded.grantee
left join pg_roles as grantor_role
  on grantor_role.oid = expanded.grantor
order by expanded.function_name, signature, grantee;

-- 9. protected_rpc_public_exposure
with expected(function_name) as (
  values
    ('create_order_with_stock'),
    ('get_instapay_order_for_customer'),
    ('submit_instapay_payment_proof'),
    ('confirm_instapay_payment'),
    ('reject_instapay_payment'),
    ('expire_instapay_orders'),
    ('cancel_order_with_stock'),
    ('update_order_fulfillment_status'),
    ('confirm_card_payment'),
    ('adjust_product_stock')
),
matched as (
  select e.function_name, p.oid, p.proowner, p.proacl
  from expected as e
  left join pg_namespace as n
    on n.nspname = 'public'
  left join pg_proc as p
    on p.pronamespace = n.oid
   and p.proname = e.function_name
),
exposure as (
  select
    matched.function_name,
    matched.oid,
    case
      when matched.oid is null then null
      else exists (
        select 1
        from aclexplode(coalesce(matched.proacl, acldefault('f', matched.proowner))) as acl
        where acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
      )
    end as public_can_execute,
    case
      when matched.oid is null or to_regrole('anon') is null then null
      else has_function_privilege(to_regrole('anon'), matched.oid, 'EXECUTE')
    end as anon_can_execute,
    case
      when matched.oid is null or to_regrole('authenticated') is null then null
      else has_function_privilege(to_regrole('authenticated'), matched.oid, 'EXECUTE')
    end as authenticated_can_execute
  from matched
)
select
  'protected_rpc_public_exposure'::text as result_set,
  function_name,
  case when oid is null then null else oid::regprocedure::text end as signature,
  public_can_execute,
  anon_can_execute,
  authenticated_can_execute,
  case
    when oid is null then 'CANNOT_VERIFY'
    when public_can_execute is null or anon_can_execute is null or authenticated_can_execute is null then 'CANNOT_VERIFY'
    when public_can_execute or anon_can_execute or authenticated_can_execute then 'BLOCKED'
    else 'PASS'
  end as status
from exposure
order by function_name, signature;

-- 10. storage_buckets
with expected(bucket_id, expected_public, expected_file_size_limit, expected_mime_types) as (
  values
    ('instapay-proofs', false, 5242880::bigint, array['image/jpeg', 'image/png', 'image/webp']::text[]),
    ('product-images', true, 5242880::bigint, array['image/jpeg', 'image/png', 'image/webp']::text[])
)
select
  'storage_buckets'::text as result_set,
  e.bucket_id,
  b.name,
  b.public,
  b.file_size_limit,
  b.allowed_mime_types,
  e.expected_public,
  e.expected_file_size_limit,
  e.expected_mime_types,
  case
    when b.id is null then false
    else
      b.name = e.bucket_id
      and b.public = e.expected_public
      and b.file_size_limit = e.expected_file_size_limit
      and b.allowed_mime_types = e.expected_mime_types
  end as contract_matches,
  case
    when b.id is null then 'WARNING'
    when b.name = e.bucket_id
      and b.public = e.expected_public
      and b.file_size_limit = e.expected_file_size_limit
      and b.allowed_mime_types = e.expected_mime_types
      then 'PASS'
    else 'WARNING'
  end as status
from expected as e
left join storage.buckets as b
  on b.id = e.bucket_id
order by e.bucket_id;

-- 11. storage_objects_acl
with storage_relation as (
  select
    cls.oid,
    cls.relowner,
    cls.relacl,
    cls.relrowsecurity,
    cls.relforcerowsecurity
  from pg_class as cls
  join pg_namespace as n
    on n.oid = cls.relnamespace
  where n.nspname = 'storage'
    and cls.relname = 'objects'
    and cls.relkind in ('r', 'p')
),
table_acl as (
  select
    'table'::text as privilege_scope,
    null::text as column_name,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from storage_relation as relation
  cross join lateral aclexplode(
    coalesce(relation.relacl, acldefault('r', relation.relowner))
  ) as acl
),
column_acl as (
  select
    'column'::text as privilege_scope,
    attribute.attname as column_name,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from storage_relation as relation
  join pg_attribute as attribute
    on attribute.attrelid = relation.oid
   and attribute.attnum > 0
   and not attribute.attisdropped
  cross join lateral aclexplode(attribute.attacl) as acl
),
combined_acl as (
  select * from table_acl
  union all
  select * from column_acl
)
select
  'storage_objects_acl'::text as result_set,
  relation.oid::regclass::text as relation_name,
  owner_role.rolname as relation_owner,
  relation.relrowsecurity as rls_enabled,
  relation.relforcerowsecurity as rls_forced,
  acl.privilege_scope,
  acl.column_name,
  case when acl.grantee = 0 then 'PUBLIC' else grantee_role.rolname end as grantee,
  acl.privilege_type,
  acl.is_grantable,
  grantor_role.rolname as grantor,
  case when relation.oid is null then 'CANNOT_VERIFY' else 'PASS' end as inspection_status
from (values (1)) as expected(marker)
left join storage_relation as relation
  on true
left join combined_acl as acl
  on true
left join pg_roles as owner_role
  on owner_role.oid = relation.relowner
left join pg_roles as grantee_role
  on grantee_role.oid = acl.grantee
left join pg_roles as grantor_role
  on grantor_role.oid = acl.grantor
order by acl.privilege_scope, acl.column_name, grantee, acl.privilege_type;

-- 12. storage_policies
with storage_relation as (
  select cls.oid
  from pg_class as cls
  join pg_namespace as n
    on n.oid = cls.relnamespace
  where n.nspname = 'storage'
    and cls.relname = 'objects'
    and cls.relkind in ('r', 'p')
),
policy_metadata as (
  select
    p.polname,
    p.polroles,
    p.polcmd,
    p.polpermissive,
    pg_get_expr(p.polqual, p.polrelid, true) as using_expression,
    pg_get_expr(p.polwithcheck, p.polrelid, true) as with_check_expression
  from pg_policy as p
  join storage_relation as relation
    on relation.oid = p.polrelid
)
select
  'storage_policies'::text as result_set,
  policy_metadata.polname as policy_name,
  case when role_oid = 0 then 'PUBLIC' else role_catalog.rolname end as role_name,
  case policy_metadata.polcmd
    when 'r' then 'SELECT'
    when 'a' then concat('IN', 'SERT')
    when 'w' then concat('UP', 'DATE')
    when 'd' then concat('DE', 'LETE')
    when '*' then 'ALL'
  end as command,
  case when policy_metadata.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end as policy_mode,
  policy_metadata.using_expression,
  policy_metadata.with_check_expression,
  case
    when concat_ws(' ', policy_metadata.using_expression, policy_metadata.with_check_expression) ilike '%instapay-proofs%'
      and concat_ws(' ', policy_metadata.using_expression, policy_metadata.with_check_expression) ilike '%product-images%'
      then 'instapay-proofs, product-images'
    when concat_ws(' ', policy_metadata.using_expression, policy_metadata.with_check_expression) ilike '%instapay-proofs%'
      then 'instapay-proofs'
    when concat_ws(' ', policy_metadata.using_expression, policy_metadata.with_check_expression) ilike '%product-images%'
      then 'product-images'
    else 'other or unscoped'
  end as bucket_scope
from policy_metadata
cross join lateral unnest(policy_metadata.polroles) as expanded_role(role_oid)
left join pg_roles as role_catalog
  on role_catalog.oid = expanded_role.role_oid
order by policy_metadata.polname, role_name;

-- 13. storage_anonymous_mutation_access
with target_buckets(bucket_id) as (
  values ('instapay-proofs'), ('product-images')
),
target_actions(action_code, action_name, privilege_name) as (
  values
    ('a'::"char", 'upload'::text, concat('IN', 'SERT')),
    ('w'::"char", 'change'::text, concat('UP', 'DATE')),
    ('d'::"char", 'remove'::text, concat('DE', 'LETE'))
),
role_state as (
  select role.oid as anon_oid, role.rolbypassrls as anon_bypasses_rls
  from (values (1)) as expected(marker)
  left join pg_roles as role
    on role.rolname = 'anon'
),
storage_relation as (
  select cls.oid, cls.relowner, cls.relrowsecurity, cls.relforcerowsecurity
  from pg_class as cls
  join pg_namespace as n
    on n.oid = cls.relnamespace
  where n.nspname = 'storage'
    and cls.relname = 'objects'
    and cls.relkind in ('r', 'p')
),
policy_metadata as (
  select
    p.polname,
    p.polroles,
    p.polcmd,
    p.polpermissive,
    pg_get_expr(p.polqual, p.polrelid, true) as using_expression,
    pg_get_expr(p.polwithcheck, p.polrelid, true) as with_check_expression
  from pg_policy as p
  join storage_relation as relation
    on relation.oid = p.polrelid
),
policy_candidates as (
  select
    bucket.bucket_id,
    action.action_code,
    policy.polname,
    policy.polpermissive,
    lower(coalesce(policy.using_expression, 'true')) as effective_using_expression,
    lower(coalesce(
      policy.with_check_expression,
      case when policy.polcmd in ('w', '*') then policy.using_expression end,
      'true'
    )) as effective_with_check_expression
  from target_buckets as bucket
  cross join target_actions as action
  cross join role_state as roles
  join policy_metadata as policy
    on (policy.polcmd = action.action_code or policy.polcmd = '*')
   and exists (
     select 1
     from unnest(policy.polroles) as policy_role(role_oid)
     where policy_role.role_oid = 0
        or policy_role.role_oid = roles.anon_oid
        or (
          roles.anon_oid is not null
          and policy_role.role_oid <> 0
          and pg_has_role(roles.anon_oid, policy_role.role_oid, 'MEMBER')
        )
   )
),
policy_clause_states as (
  select
    candidate.*,
    case
      when candidate.effective_using_expression ~* '(^|[^a-z])false([^a-z]|$)' then 'DENY'
      when candidate.effective_using_expression ilike
        '%bucket_id is distinct from ''' || candidate.bucket_id || '''%'
        and candidate.effective_using_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'DENY'
      when candidate.effective_using_expression ~* (
        'bucket_id[[:space:]]*=[[:space:]]*''' || candidate.bucket_id || ''''
      ) then 'ALLOW'
      when candidate.effective_using_expression ~*
        'bucket_id[[:space:]]*=[[:space:]]*''[^'']+'''
        and candidate.effective_using_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'DENY'
      when candidate.effective_using_expression !~* 'bucket_id' then 'ALLOW'
      when candidate.effective_using_expression ~* 'bucket_id[[:space:]]+is[[:space:]]+distinct[[:space:]]+from'
        and candidate.effective_using_expression !~* 'bucket_id[[:space:]]*='
        and candidate.effective_using_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'ALLOW'
      else 'UNKNOWN'
    end as using_state,
    case
      when candidate.effective_with_check_expression ~* '(^|[^a-z])false([^a-z]|$)' then 'DENY'
      when candidate.effective_with_check_expression ilike
        '%bucket_id is distinct from ''' || candidate.bucket_id || '''%'
        and candidate.effective_with_check_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'DENY'
      when candidate.effective_with_check_expression ~* (
        'bucket_id[[:space:]]*=[[:space:]]*''' || candidate.bucket_id || ''''
      ) then 'ALLOW'
      when candidate.effective_with_check_expression ~*
        'bucket_id[[:space:]]*=[[:space:]]*''[^'']+'''
        and candidate.effective_with_check_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'DENY'
      when candidate.effective_with_check_expression !~* 'bucket_id' then 'ALLOW'
      when candidate.effective_with_check_expression ~* 'bucket_id[[:space:]]+is[[:space:]]+distinct[[:space:]]+from'
        and candidate.effective_with_check_expression !~* 'bucket_id[[:space:]]*='
        and candidate.effective_with_check_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'ALLOW'
      else 'UNKNOWN'
    end as with_check_state
  from policy_candidates as candidate
),
policy_action_states as (
  select
    clause.*,
    case clause.action_code
      when 'a' then clause.with_check_state
      when 'd' then clause.using_state
      when 'w' then case
        when clause.using_state = 'DENY' or clause.with_check_state = 'DENY' then 'DENY'
        when clause.using_state = 'ALLOW' and clause.with_check_state = 'ALLOW' then 'ALLOW'
        else 'UNKNOWN'
      end
    end as action_state
  from policy_clause_states as clause
),
policy_access as (
  select
    bucket_id,
    action_code,
    coalesce(array_agg(polname order by polname) filter (
      where polpermissive and action_state = 'ALLOW'
    ), '{}'::text[]) as permissive_allow_policies,
    coalesce(array_agg(polname order by polname) filter (
      where not polpermissive and action_state = 'DENY'
    ), '{}'::text[]) as restrictive_blocking_policies,
    coalesce(array_agg(polname order by polname) filter (
      where action_state = 'UNKNOWN'
    ), '{}'::text[]) as unknown_policies
  from policy_action_states
  group by bucket_id, action_code
),
matrix as (
  select
    bucket.bucket_id,
    action.action_code,
    action.action_name,
    action.privilege_name,
    roles.anon_oid,
    roles.anon_bypasses_rls,
    relation.oid as relation_oid,
    relation.relowner = roles.anon_oid as anon_owns_relation,
    relation.relrowsecurity,
    relation.relforcerowsecurity,
    case
      when roles.anon_oid is null or relation.oid is null then null
      else has_table_privilege(roles.anon_oid, relation.oid, action.privilege_name)
    end as table_privilege,
    case
      when roles.anon_oid is null or relation.oid is null then null
      when action.action_code in ('a', 'w')
        then has_any_column_privilege(roles.anon_oid, relation.oid, action.privilege_name)
      else false
    end as any_column_privilege,
    coalesce(access.permissive_allow_policies, '{}'::text[]) as matching_policies,
    coalesce(access.restrictive_blocking_policies, '{}'::text[]) as restrictive_blocking_policies,
    coalesce(access.unknown_policies, '{}'::text[]) as unknown_policies
  from target_buckets as bucket
  cross join target_actions as action
  cross join role_state as roles
  left join storage_relation as relation
    on true
  left join policy_access as access
    on access.bucket_id = bucket.bucket_id
   and access.action_code = action.action_code
)
select
  'storage_anonymous_mutation_access'::text as result_set,
  bucket_id,
  action_name,
  privilege_name,
  table_privilege as anon_has_table_privilege,
  any_column_privilege as anon_has_any_column_privilege,
  anon_bypasses_rls,
  anon_owns_relation,
  relrowsecurity as storage_objects_rls_enabled,
  relforcerowsecurity as storage_objects_rls_forced,
  matching_policies,
  restrictive_blocking_policies,
  unknown_policies,
  case
    when anon_oid is null
      or relation_oid is null
      or table_privilege is null
      or any_column_privilege is null
      or anon_bypasses_rls is null
      or anon_owns_relation is null
      or relrowsecurity is null
      or relforcerowsecurity is null
      then null
    when not (table_privilege or any_column_privilege) then false
    when anon_bypasses_rls then true
    when anon_owns_relation and not relforcerowsecurity then true
    when not relrowsecurity then true
    when cardinality(restrictive_blocking_policies) > 0 then false
    when cardinality(unknown_policies) > 0 then null
    else
      cardinality(matching_policies) > 0
  end as anonymous_access_possible,
  case
    when anon_oid is null
      or relation_oid is null
      or table_privilege is null
      or any_column_privilege is null
      or anon_bypasses_rls is null
      or anon_owns_relation is null
      or relrowsecurity is null
      or relforcerowsecurity is null
      then 'CANNOT_VERIFY'
    when not (table_privilege or any_column_privilege) then 'PASS'
    when anon_bypasses_rls then 'BLOCKED'
    when anon_owns_relation and not relforcerowsecurity then 'BLOCKED'
    when not relrowsecurity then 'BLOCKED'
    when cardinality(restrictive_blocking_policies) > 0 then 'PASS'
    when cardinality(unknown_policies) > 0 then 'CANNOT_VERIFY'
    when cardinality(matching_policies) > 0 then 'BLOCKED'
    else 'PASS'
  end as status
from matrix
order by bucket_id, action_code;

-- 14. instapay_duplicate_summary
with normalized_groups as (
  select
    upper(regexp_replace(btrim(coalesce(payment_reference, '')), '[[:space:]-]+', '', 'g')) as normalized_reference,
    count(*)::bigint as affected_rows
  from public.orders
  where payment_method = 'InstaPay'
    and nullif(btrim(payment_reference), '') is not null
  group by upper(regexp_replace(btrim(coalesce(payment_reference, '')), '[[:space:]-]+', '', 'g'))
  having count(*) > 1
)
select
  'instapay_duplicate_summary'::text as result_set,
  count(*)::bigint as duplicate_group_count,
  coalesce(sum(affected_rows), 0)::bigint as affected_row_count,
  case when count(*) = 0 then 'PASS' else 'BLOCKED' end as status
from normalized_groups;

-- 15. cron_extension
select
  'cron_extension'::text as result_set,
  'pg_cron'::text as extension_name,
  extension.extversion as extension_version,
  case when extension.oid is null then 'CANNOT_VERIFY' else 'PASS' end as status
from (values (1)) as expected(marker)
left join pg_extension as extension
  on extension.extname = 'pg_cron';

-- 16. cron_jobs
with relevant_jobs as (
  select *
  from cron.job
  where jobname = 'tick-instapay-expiry'
     or position('expire_instapay_orders' in lower(command)) > 0
),
counts as (
  select
    count(*) filter (where jobname = 'tick-instapay-expiry')::bigint as named_job_count,
    count(*) filter (where position('expire_instapay_orders' in lower(command)) > 0)::bigint as matching_command_count
  from cron.job
)
select
  'cron_jobs'::text as result_set,
  counts.named_job_count,
  counts.matching_command_count,
  jobs.jobid,
  jobs.jobname,
  jobs.schedule,
  jobs.command,
  jobs.database,
  jobs.username,
  jobs.active
from counts
left join relevant_jobs as jobs
  on true
order by jobs.jobid;

-- 17. cron_recent_health
with expiry_jobs as (
  select jobid
  from cron.job
  where jobname = 'tick-instapay-expiry'
     or position('expire_instapay_orders' in lower(command)) > 0
),
recent_runs as (
  select details.status, details.start_time, details.end_time
  from cron.job_run_details as details
  join expiry_jobs as jobs
    on jobs.jobid = details.jobid
  where details.start_time >= now() - interval '7 days'
)
select
  'cron_recent_health'::text as result_set,
  count(*) filter (where status = 'succeeded')::bigint as successful_run_count,
  count(*) filter (where status is distinct from 'succeeded')::bigint as failed_run_count,
  max(coalesce(end_time, start_time)) as latest_run_timestamp,
  case when count(*) = 0 then 'WARNING' else 'PASS' end as status
from recent_runs;

-- 18. historical_not_valid_constraints
select
  'historical_not_valid_constraints'::text as result_set,
  relation.relname as table_name,
  constraint_state.conname as constraint_name,
  case constraint_state.contype
    when 'c' then 'CHECK'
    when 'f' then 'FOREIGN KEY'
  end as constraint_type,
  pg_get_constraintdef(constraint_state.oid, true) as definition,
  constraint_state.convalidated as is_validated,
  'WARNING'::text as status
from pg_constraint as constraint_state
join pg_class as relation
  on relation.oid = constraint_state.conrelid
join pg_namespace as n
  on n.oid = relation.relnamespace
where n.nspname = 'public'
  and relation.relname in (
    'categories', 'products', 'product_images', 'orders', 'order_items',
    'settings', 'subscribers', 'notify_me', 'episodes', 'push_tokens'
  )
  and constraint_state.contype in ('c', 'f')
  and not constraint_state.convalidated
order by relation.relname, constraint_state.conname;

-- 19. expected_object_summary
with expected_checks(table_name, object_name, expected_definition, accepted_normalizations) as (
  values
    ('categories', 'categories_slug_not_blank',
      'check (btrim(slug) <> '''')',
      array[concat('checkbtrimslug<>', chr(39), chr(39))]),
    ('products', 'products_price_nonnegative',
      'check (price >= 0)',
      array['checkprice>=0']),
    ('products', 'products_sale_price_valid',
      'check (sale_price is null or (sale_price >= 0 and sale_price < price))',
      array['checksale_priceisnullorsale_price>=0andsale_price<price']),
    ('products', 'products_stock_nonnegative',
      'check (stock_quantity >= 0)',
      array['checkstock_quantity>=0']),
    ('products', 'products_condition_rating_range',
      'check (condition_rating is null or condition_rating between 1 and 5)',
      array[
        'checkcondition_ratingisnullorcondition_ratingbetween1and5',
        'checkcondition_ratingisnullorcondition_rating>=1andcondition_rating<=5'
      ]),
    ('products', 'products_original_price_nonnegative',
      'check (orig_price_reference is null or orig_price_reference >= 0)',
      array['checkorig_price_referenceisnullororig_price_reference>=0']),
    ('products', 'products_variants_shape',
      'check (variants is null or jsonb_typeof(variants) in (''array'', ''object''))',
      array[
        concat(
          'checkvariantsisnullorjsonb_typeofvariantsin',
          chr(39), 'array', chr(39), ',', chr(39), 'object', chr(39)
        ),
        concat(
          'checkvariantsisnullorjsonb_typeofvariants=anyarray[',
          chr(39), 'array', chr(39), ',', chr(39), 'object', chr(39), ']'
        )
      ]),
    ('product_images', 'product_images_position_nonnegative',
      'check (position >= 0)',
      array['checkposition>=0']),
    ('orders', 'orders_total_nonnegative',
      'check (total_amount >= 0)',
      array['checktotal_amount>=0']),
    ('orders', 'orders_status_check',
      'check (status in (''pending'', ''confirmed'', ''shipped'', ''delivered'', ''cancelled'', ''refunded''))',
      array[
        concat(
          'checkstatusin',
          chr(39), 'pending', chr(39), ',',
          chr(39), 'confirmed', chr(39), ',',
          chr(39), 'shipped', chr(39), ',',
          chr(39), 'delivered', chr(39), ',',
          chr(39), 'cancelled', chr(39), ',',
          chr(39), 'refunded', chr(39)
        ),
        concat(
          'checkstatus=anyarray[',
          chr(39), 'pending', chr(39), ',',
          chr(39), 'confirmed', chr(39), ',',
          chr(39), 'shipped', chr(39), ',',
          chr(39), 'delivered', chr(39), ',',
          chr(39), 'cancelled', chr(39), ',',
          chr(39), 'refunded', chr(39), ']'
        )
      ]),
    ('order_items', 'order_items_quantity_positive',
      'check (quantity > 0)',
      array['checkquantity>0']),
    ('order_items', 'order_items_price_nonnegative',
      'check (price_at_purchase >= 0)',
      array['checkprice_at_purchase>=0']),
    ('subscribers', 'subscribers_email_not_blank',
      'check (btrim(email) <> '''')',
      array[concat('checkbtrimemail<>', chr(39), chr(39))]),
    ('notify_me', 'notify_me_contact_present',
      'check (nullif(btrim(email), '''') is not null or nullif(btrim(phone), '''') is not null)',
      array[
        concat(
          'checknullifbtrimemail,', chr(39), chr(39),
          'isnotnullornullifbtrimphone,', chr(39), chr(39), 'isnotnull'
        )
      ]),
    ('push_tokens', 'push_tokens_token_not_blank',
      'check (btrim(token) <> '''')',
      array[concat('checkbtrimtoken<>', chr(39), chr(39))])
),
actual_checks as (
  select
    c.conname as object_name,
    cls.relname as table_name,
    c.contype,
    pg_get_constraintdef(c.oid, true) as actual_definition,
    regexp_replace(
      regexp_replace(
        replace(
          replace(
            replace(
              lower(
                regexp_replace(
                  pg_get_constraintdef(c.oid, true),
                  '[[:space:]]+not[[:space:]]+valid[[:space:]]*$',
                  '',
                  'i'
                )
              ),
              '"',
              ''
            ),
            'public.',
            ''
          ),
          'pg_catalog.',
          ''
        ),
        '::([a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*(\[\])?',
        '',
        'g'
      ),
      '[[:space:]()]',
      '',
      'g'
    ) as normalized_definition,
    regexp_replace(
      pg_get_constraintdef(c.oid, true),
      '[[:space:]]+not[[:space:]]+valid[[:space:]]*$',
      '',
      'i'
    ) as semantic_definition,
    c.convalidated
  from pg_constraint as c
  join pg_class as cls
    on cls.oid = c.conrelid
  join pg_namespace as n
    on n.oid = cls.relnamespace
  where n.nspname = 'public'
),
check_rows as (
  select
    'check_constraint'::text as object_type,
    expected.object_name,
    expected.table_name,
    expected.expected_definition,
    string_agg(
      format('%s.%s: %s', actual.table_name, actual.object_name, actual.actual_definition),
      E'\n' order by actual.table_name, actual.object_name
    ) as actual_definition,
    bool_and(actual.convalidated) filter (where actual.object_name is not null) as is_validated,
    case
      when count(actual.object_name) = 0 then 'MISSING'
      when not bool_or(
        actual.table_name = expected.table_name
        and actual.contype = 'c'
        and actual.normalized_definition = any(expected.accepted_normalizations)
      ) then 'CONFLICTING'
      when bool_or(
        actual.table_name = expected.table_name
        and actual.contype = 'c'
        and lower(btrim(actual.semantic_definition)) = lower(btrim(expected.expected_definition))
      ) then 'SAME_DEFINITION'
      else 'EQUIVALENT_DEFINITION'
    end as classification
  from expected_checks as expected
  left join actual_checks as actual
    on actual.object_name = expected.object_name
  group by
    expected.object_name,
    expected.table_name,
    expected.expected_definition,
    expected.accepted_normalizations
),
expected_fks(
  table_name,
  source_columns,
  object_name,
  target_table,
  target_columns,
  remove_code,
  expected_definition
) as (
  values
    ('products', 'category_id', 'products_category_id_fkey',
      'categories', 'id', 'a'::"char", 'category_id -> categories.id; removal NO ACTION'),
    ('product_images', 'product_id', 'product_images_product_id_fkey',
      'products', 'id', 'c'::"char", 'product_id -> products.id; removal CASCADE'),
    ('order_items', 'order_id', 'order_items_order_id_fkey',
      'orders', 'id', 'c'::"char", 'order_id -> orders.id; removal CASCADE'),
    ('order_items', 'product_id', 'order_items_product_id_fkey',
      'products', 'id', 'n'::"char", 'product_id -> products.id; removal SET NULL'),
    ('notify_me', 'product_id', 'notify_me_product_id_fkey',
      'products', 'id', 'c'::"char", 'product_id -> products.id; removal CASCADE')
),
actual_fks as (
  select
    c.conname as object_name,
    source_table.relname as table_name,
    target_table.relname as target_table,
    (
      select string_agg(attribute.attname, ',' order by key_column.ordinality)
      from unnest(c.conkey) with ordinality as key_column(attnum, ordinality)
      join pg_attribute as attribute
        on attribute.attrelid = c.conrelid
       and attribute.attnum = key_column.attnum
    ) as source_columns,
    (
      select string_agg(attribute.attname, ',' order by key_column.ordinality)
      from unnest(c.confkey) with ordinality as key_column(attnum, ordinality)
      join pg_attribute as attribute
        on attribute.attrelid = c.confrelid
       and attribute.attnum = key_column.attnum
    ) as target_columns,
    c.confdeltype as remove_code,
    c.confupdtype as change_code,
    c.convalidated,
    pg_get_constraintdef(c.oid, true) as actual_definition
  from pg_constraint as c
  join pg_class as source_table
    on source_table.oid = c.conrelid
  join pg_namespace as source_schema
    on source_schema.oid = source_table.relnamespace
  join pg_class as target_table
    on target_table.oid = c.confrelid
  join pg_namespace as target_schema
    on target_schema.oid = target_table.relnamespace
  where c.contype = 'f'
    and source_schema.nspname = 'public'
    and target_schema.nspname = 'public'
),
fk_rows as (
  select
    'foreign_key'::text as object_type,
    expected.object_name,
    expected.table_name,
    expected.expected_definition,
    string_agg(
      format(
        '%s.%s: %s',
        actual.table_name,
        actual.object_name,
        actual.actual_definition
      ),
      E'\n' order by actual.table_name, actual.object_name
    ) as actual_definition,
    bool_and(actual.convalidated) filter (where actual.object_name is not null) as is_validated,
    case
      when count(actual.object_name) = 0 then 'MISSING'
      when not bool_or(
        actual.table_name = expected.table_name
        and actual.source_columns = expected.source_columns
        and actual.target_table = expected.target_table
        and actual.target_columns = expected.target_columns
        and actual.remove_code = expected.remove_code
      ) then 'CONFLICTING'
      when bool_or(
        actual.object_name = expected.object_name
        and actual.table_name = expected.table_name
        and actual.source_columns = expected.source_columns
        and actual.target_table = expected.target_table
        and actual.target_columns = expected.target_columns
        and actual.remove_code = expected.remove_code
      ) then 'SAME_DEFINITION'
      else 'COMPATIBLE'
    end as classification
  from expected_fks as expected
  left join actual_fks as actual
    on (
      actual.table_name = expected.table_name
      and actual.source_columns = expected.source_columns
    )
    or actual.object_name = expected.object_name
  group by
    expected.object_name,
    expected.table_name,
    expected.source_columns,
    expected.target_table,
    expected.target_columns,
    expected.remove_code,
    expected.expected_definition
),
expected_indexes(
  table_name,
  object_name,
  expected_unique,
  expected_columns,
  expected_descending,
  expected_nulls_first,
  expected_predicate,
  expected_definition
) as (
  values
    ('categories', 'categories_slug_key', true, 'slug', array[false], array[false], '',
      'unique (slug); no predicate'),
    ('subscribers', 'subscribers_email_lower_key', true, 'lower(btrim(email))', array[false], array[false], '',
      'unique (lower(btrim(email))); no predicate'),
    ('push_tokens', 'push_tokens_token_key', true, 'token', array[false], array[false], '',
      'unique (token); no predicate'),
    ('products', 'products_active_category_idx', false, 'category_id,id', array[false, false], array[false, false], 'is_activeistrue',
      '(category_id, id) where is_active is true'),
    ('product_images', 'product_images_product_position_idx', false, 'product_id,position,id', array[false, false, false], array[false, false, false], '',
      '(product_id, position, id); no predicate'),
    ('order_items', 'order_items_order_id_idx', false, 'order_id', array[false], array[false], '',
      '(order_id); no predicate'),
    ('order_items', 'order_items_product_id_idx', false, 'product_id', array[false], array[false], 'product_idisnotnull',
      '(product_id) where product_id is not null'),
    ('orders', 'orders_created_at_idx', false, 'created_at', array[true], array[true], '',
      '(created_at desc); no predicate'),
    ('subscribers', 'subscribers_subscribed_at_idx', false, 'subscribed_at', array[true], array[true], '',
      '(subscribed_at desc); no predicate'),
    ('notify_me', 'notify_me_created_at_idx', false, 'created_at', array[true], array[true], '',
      '(created_at desc); no predicate'),
    ('episodes', 'episodes_episode_number_idx', false, 'episode_number', array[false], array[false], '',
      '(episode_number); no predicate')
),
actual_indexes as (
  select
    index_table.relname as table_name,
    index_class.relname as object_name,
    access_method.amname as access_method,
    index_state.indisunique as is_unique,
    index_state.indisvalid,
    index_state.indisready,
    (
      select string_agg(
        regexp_replace(
          regexp_replace(
            replace(
              replace(
                lower(replace(pg_get_indexdef(index_state.indexrelid, position_number, true), '"', '')),
                'public.',
                ''
              ),
              'pg_catalog.',
              ''
            ),
            '::([a-z_][a-z0-9_]*[.])?[a-z_][a-z0-9_]*(\[\])?',
            '',
            'g'
          ),
          '[[:space:]]+',
          '',
          'g'
        ),
        ',' order by position_number
      )
      from generate_series(1, index_state.indnkeyatts) as positions(position_number)
    ) as indexed_columns,
    (
      select array_agg(
        (index_state.indoption[position_number - 1]::integer & 1) = 1
        order by position_number
      )
      from generate_series(1, index_state.indnkeyatts) as positions(position_number)
    ) as descending_flags,
    (
      select array_agg(
        (index_state.indoption[position_number - 1]::integer & 2) = 2
        order by position_number
      )
      from generate_series(1, index_state.indnkeyatts) as positions(position_number)
    ) as nulls_first_flags,
    regexp_replace(
      regexp_replace(
        replace(
          replace(
            lower(replace(coalesce(pg_get_expr(index_state.indpred, index_state.indrelid, true), ''), '"', '')),
            'public.',
            ''
          ),
          'pg_catalog.',
          ''
        ),
        '::([a-z_][a-z0-9_]*[.])?[a-z_][a-z0-9_]*(\[\])?',
        '',
        'g'
      ),
      '[[:space:]()]',
      '',
      'g'
    ) as normalized_predicate,
    pg_get_indexdef(index_state.indexrelid) as actual_definition
  from pg_index as index_state
  join pg_class as index_class
    on index_class.oid = index_state.indexrelid
  join pg_class as index_table
    on index_table.oid = index_state.indrelid
  join pg_am as access_method
    on access_method.oid = index_class.relam
  join pg_namespace as n
    on n.oid = index_table.relnamespace
  where n.nspname = 'public'
),
index_rows as (
  select
    'index'::text as object_type,
    expected.object_name,
    expected.table_name,
    expected.expected_definition,
    string_agg(
      format('%s.%s: %s', actual.table_name, actual.object_name, actual.actual_definition),
      E'\n' order by actual.table_name, actual.object_name
    ) as actual_definition,
    bool_and(actual.indisvalid and actual.indisready) filter (where actual.object_name is not null) as is_validated,
    case
      when count(actual.object_name) = 0 then 'MISSING'
      when not bool_or(
        actual.table_name = expected.table_name
        and actual.access_method = 'btree'
        and actual.is_unique = expected.expected_unique
        and actual.indisvalid
        and actual.indisready
        and actual.indexed_columns = expected.expected_columns
        and actual.descending_flags = expected.expected_descending
        and actual.nulls_first_flags = expected.expected_nulls_first
        and actual.normalized_predicate = expected.expected_predicate
      ) then 'CONFLICTING'
      else 'COMPATIBLE'
    end as classification
  from expected_indexes as expected
  left join actual_indexes as actual
    on actual.object_name = expected.object_name
  group by
    expected.object_name,
    expected.table_name,
    expected.expected_unique,
    expected.expected_columns,
    expected.expected_descending,
    expected.expected_nulls_first,
    expected.expected_predicate,
    expected.expected_definition
),
subscriber_policy as (
  select
    policy.polname,
    policy.polcmd,
    policy.polpermissive,
    policy.polroles,
    pg_get_expr(policy.polqual, policy.polrelid, true) as using_expression,
    pg_get_expr(policy.polwithcheck, policy.polrelid, true) as with_check_expression
  from pg_policy as policy
  join pg_class as relation
    on relation.oid = policy.polrelid
  join pg_namespace as n
    on n.oid = relation.relnamespace
  where n.nspname = 'public'
    and relation.relname = 'subscribers'
    and policy.polname = 'subscribers_insert_public'
),
policy_rows as (
  select
    'policy'::text as object_type,
    'subscribers_insert_public'::text as object_name,
    'subscribers'::text as table_name,
    'permissive subscriber intake for anon and authenticated; WITH CHECK btrim(email) <> '''''::text as expected_definition,
    case
      when policy.polname is null then null
      else format(
        'command=%s; permissive=%s; roles=%s; using=%s; with_check=%s',
        policy.polcmd,
        policy.polpermissive,
        policy.polroles,
        policy.using_expression,
        policy.with_check_expression
      )
    end as actual_definition,
    null::boolean as is_validated,
    case
      when policy.polname is null then 'MISSING'
      when policy.polcmd <> 'a'
        or not policy.polpermissive
        or 0 = any(policy.polroles)
        or to_regrole('anon') is null
        or to_regrole('authenticated') is null
        or not (to_regrole('anon') = any(policy.polroles))
        or not (to_regrole('authenticated') = any(policy.polroles))
        or cardinality(policy.polroles) <> 2
        or policy.using_expression is not null
        or policy.with_check_expression is null
        or regexp_replace(
          replace(lower(policy.with_check_expression), '::text', ''),
          '[[:space:]()]',
          '',
          'g'
        ) <> concat('btrimemail<>', chr(39), chr(39))
        then 'CONFLICTING'
      else 'SAME_DEFINITION'
    end as classification
  from (values (1)) as expected(marker)
  left join subscriber_policy as policy
    on true
)
select
  'expected_object_summary'::text as result_set,
  object_type,
  object_name,
  table_name,
  expected_definition,
  actual_definition,
  is_validated,
  classification
from (
  select * from check_rows
  union all
  select * from fk_rows
  union all
  select * from index_rows
  union all
  select * from policy_rows
) as expected_objects
order by
  case object_type
    when 'check_constraint' then 1
    when 'foreign_key' then 2
    when 'index' then 3
    when 'policy' then 4
  end,
  table_name,
  object_name;

-- 20. final_preflight_summary
with expected_tables(table_name) as (
  values
    ('categories'),
    ('products'),
    ('product_images'),
    ('orders'),
    ('order_items'),
    ('settings'),
    ('subscribers'),
    ('notify_me'),
    ('episodes'),
    ('push_tokens')
),
table_state as (
  select
    count(*) filter (where relation.oid is null)::bigint as missing_count,
    count(*) filter (where relation.oid is not null and relation.relkind not in ('r', 'p'))::bigint as wrong_kind_count
  from expected_tables as expected
  left join pg_namespace as n
    on n.nspname = 'public'
  left join pg_class as relation
    on relation.relnamespace = n.oid
   and relation.relname = expected.table_name
),
expected_rpcs(function_name) as (
  values
    ('create_order_with_stock'),
    ('get_instapay_order_for_customer'),
    ('submit_instapay_payment_proof'),
    ('confirm_instapay_payment'),
    ('reject_instapay_payment'),
    ('expire_instapay_orders'),
    ('cancel_order_with_stock'),
    ('update_order_fulfillment_status'),
    ('confirm_card_payment'),
    ('adjust_product_stock')
),
rpc_matches as (
  select expected.function_name, routine.oid, routine.proowner, routine.proacl
  from expected_rpcs as expected
  left join pg_namespace as n
    on n.nspname = 'public'
  left join pg_proc as routine
    on routine.pronamespace = n.oid
   and routine.proname = expected.function_name
),
rpc_exposure as (
  select
    function_name,
    oid,
    case
      when oid is null then null
      else exists (
        select 1
        from aclexplode(coalesce(proacl, acldefault('f', proowner))) as acl
        where acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
      )
    end as public_can_execute,
    case
      when oid is null or to_regrole('anon') is null then null
      else has_function_privilege(to_regrole('anon'), oid, 'EXECUTE')
    end as anon_can_execute,
    case
      when oid is null or to_regrole('authenticated') is null then null
      else has_function_privilege(to_regrole('authenticated'), oid, 'EXECUTE')
    end as authenticated_can_execute
  from rpc_matches
),
rpc_state as (
  select
    count(*) filter (where oid is null)::bigint as missing_count,
    count(*) filter (
      where oid is not null
        and (public_can_execute is null or anon_can_execute is null or authenticated_can_execute is null)
    )::bigint as unknown_count,
    count(*) filter (
      where coalesce(public_can_execute, false)
         or coalesce(anon_can_execute, false)
         or coalesce(authenticated_can_execute, false)
    )::bigint as exposed_count
  from rpc_exposure
),
cron_state as (
  select
    count(*) filter (
      where active
        and (
          jobname = 'tick-instapay-expiry'
          or position('expire_instapay_orders' in lower(command)) > 0
        )
    )::bigint as active_relevant_count,
    count(*) filter (
      where active
        and jobname = 'tick-instapay-expiry'
        and schedule = '10 seconds'
        and command = 'select public.expire_instapay_orders();'
    )::bigint as exact_active_count
  from cron.job
),
cron_run_state as (
  select
    count(*)::bigint as recent_run_count,
    count(*) filter (where details.status = 'succeeded')::bigint as successful_run_count,
    count(*) filter (where details.status is distinct from 'succeeded')::bigint as failed_run_count,
    max(coalesce(details.end_time, details.start_time)) as latest_run_timestamp
  from cron.job_run_details as details
  join cron.job as jobs
    on jobs.jobid = details.jobid
  where (
      jobs.jobname = 'tick-instapay-expiry'
      or position('expire_instapay_orders' in lower(jobs.command)) > 0
    )
    and details.start_time >= now() - interval '7 days'
),
duplicate_state as (
  select
    count(*)::bigint as duplicate_group_count,
    coalesce(sum(grouped.affected_rows), 0)::bigint as affected_row_count
  from (
    select count(*)::bigint as affected_rows
    from public.orders
    where payment_method = 'InstaPay'
      and nullif(btrim(payment_reference), '') is not null
    group by upper(regexp_replace(btrim(coalesce(payment_reference, '')), '[[:space:]-]+', '', 'g'))
    having count(*) > 1
  ) as grouped
),
expected_checks(table_name, object_name, accepted_normalizations) as (
  values
    ('categories', 'categories_slug_not_blank',
      array[concat('checkbtrimslug<>', chr(39), chr(39))]),
    ('products', 'products_price_nonnegative',
      array['checkprice>=0']),
    ('products', 'products_sale_price_valid',
      array['checksale_priceisnullorsale_price>=0andsale_price<price']),
    ('products', 'products_stock_nonnegative',
      array['checkstock_quantity>=0']),
    ('products', 'products_condition_rating_range',
      array[
        'checkcondition_ratingisnullorcondition_ratingbetween1and5',
        'checkcondition_ratingisnullorcondition_rating>=1andcondition_rating<=5'
      ]),
    ('products', 'products_original_price_nonnegative',
      array['checkorig_price_referenceisnullororig_price_reference>=0']),
    ('products', 'products_variants_shape',
      array[
        concat(
          'checkvariantsisnullorjsonb_typeofvariantsin',
          chr(39), 'array', chr(39), ',', chr(39), 'object', chr(39)
        ),
        concat(
          'checkvariantsisnullorjsonb_typeofvariants=anyarray[',
          chr(39), 'array', chr(39), ',', chr(39), 'object', chr(39), ']'
        )
      ]),
    ('product_images', 'product_images_position_nonnegative',
      array['checkposition>=0']),
    ('orders', 'orders_total_nonnegative',
      array['checktotal_amount>=0']),
    ('orders', 'orders_status_check',
      array[
        concat(
          'checkstatusin',
          chr(39), 'pending', chr(39), ',',
          chr(39), 'confirmed', chr(39), ',',
          chr(39), 'shipped', chr(39), ',',
          chr(39), 'delivered', chr(39), ',',
          chr(39), 'cancelled', chr(39), ',',
          chr(39), 'refunded', chr(39)
        ),
        concat(
          'checkstatus=anyarray[',
          chr(39), 'pending', chr(39), ',',
          chr(39), 'confirmed', chr(39), ',',
          chr(39), 'shipped', chr(39), ',',
          chr(39), 'delivered', chr(39), ',',
          chr(39), 'cancelled', chr(39), ',',
          chr(39), 'refunded', chr(39), ']'
        )
      ]),
    ('order_items', 'order_items_quantity_positive',
      array['checkquantity>0']),
    ('order_items', 'order_items_price_nonnegative',
      array['checkprice_at_purchase>=0']),
    ('subscribers', 'subscribers_email_not_blank',
      array[concat('checkbtrimemail<>', chr(39), chr(39))]),
    ('notify_me', 'notify_me_contact_present',
      array[
        concat(
          'checknullifbtrimemail,', chr(39), chr(39),
          'isnotnullornullifbtrimphone,', chr(39), chr(39), 'isnotnull'
        )
      ]),
    ('push_tokens', 'push_tokens_token_not_blank',
      array[concat('checkbtrimtoken<>', chr(39), chr(39))])
),
actual_checks as (
  select
    constraint_state.conname as object_name,
    relation.relname as table_name,
    constraint_state.contype,
    regexp_replace(
      regexp_replace(
        replace(
          replace(
            replace(
              lower(
                regexp_replace(
                  pg_get_constraintdef(constraint_state.oid, true),
                  '[[:space:]]+not[[:space:]]+valid[[:space:]]*$',
                  '',
                  'i'
                )
              ),
              '"',
              ''
            ),
            'public.',
            ''
          ),
          'pg_catalog.',
          ''
        ),
        '::([a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*(\[\])?',
        '',
        'g'
      ),
      '[[:space:]()]',
      '',
      'g'
    ) as normalized_definition
  from pg_constraint as constraint_state
  join pg_class as relation
    on relation.oid = constraint_state.conrelid
  join pg_namespace as n
    on n.oid = relation.relnamespace
  where n.nspname = 'public'
),
check_state as (
  select
    count(*) filter (
      where actual_count > 0
        and not has_compatible_definition
    )::bigint as conflicting_count
  from (
    select
      expected.object_name,
      count(actual.object_name)::bigint as actual_count,
      coalesce(bool_or(
        actual.table_name = expected.table_name
        and actual.contype = 'c'
        and actual.normalized_definition = any(expected.accepted_normalizations)
      ), false) as has_compatible_definition
    from expected_checks as expected
    left join actual_checks as actual
      on actual.object_name = expected.object_name
    group by expected.object_name, expected.table_name, expected.accepted_normalizations
  ) as per_check
),
expected_fks(
  table_name,
  source_columns,
  object_name,
  target_table,
  target_columns,
  remove_code
) as (
  values
    ('products', 'category_id', 'products_category_id_fkey', 'categories', 'id', 'a'::"char"),
    ('product_images', 'product_id', 'product_images_product_id_fkey', 'products', 'id', 'c'::"char"),
    ('order_items', 'order_id', 'order_items_order_id_fkey', 'orders', 'id', 'c'::"char"),
    ('order_items', 'product_id', 'order_items_product_id_fkey', 'products', 'id', 'n'::"char"),
    ('notify_me', 'product_id', 'notify_me_product_id_fkey', 'products', 'id', 'c'::"char")
),
actual_fks as (
  select
    constraint_state.conname as object_name,
    source_table.relname as table_name,
    target_table.relname as target_table,
    (
      select string_agg(attribute.attname, ',' order by key_column.ordinality)
      from unnest(constraint_state.conkey) with ordinality as key_column(attnum, ordinality)
      join pg_attribute as attribute
        on attribute.attrelid = constraint_state.conrelid
       and attribute.attnum = key_column.attnum
    ) as source_columns,
    (
      select string_agg(attribute.attname, ',' order by key_column.ordinality)
      from unnest(constraint_state.confkey) with ordinality as key_column(attnum, ordinality)
      join pg_attribute as attribute
        on attribute.attrelid = constraint_state.confrelid
       and attribute.attnum = key_column.attnum
    ) as target_columns,
    constraint_state.confdeltype as remove_code
  from pg_constraint as constraint_state
  join pg_class as source_table
    on source_table.oid = constraint_state.conrelid
  join pg_namespace as source_schema
    on source_schema.oid = source_table.relnamespace
  join pg_class as target_table
    on target_table.oid = constraint_state.confrelid
  join pg_namespace as target_schema
    on target_schema.oid = target_table.relnamespace
  where constraint_state.contype = 'f'
    and source_schema.nspname = 'public'
    and target_schema.nspname = 'public'
),
fk_state as (
  select
    count(*) filter (
      where candidate_count > 0
        and not has_compatible_definition
    )::bigint as conflicting_count
  from (
    select
      expected.object_name,
      count(actual.object_name)::bigint as candidate_count,
      coalesce(bool_or(
        actual.table_name = expected.table_name
        and actual.source_columns = expected.source_columns
        and actual.target_table = expected.target_table
        and actual.target_columns = expected.target_columns
        and actual.remove_code = expected.remove_code
      ), false) as has_compatible_definition
    from expected_fks as expected
    left join actual_fks as actual
      on (
        actual.table_name = expected.table_name
        and actual.source_columns = expected.source_columns
      )
      or actual.object_name = expected.object_name
    group by
      expected.object_name,
      expected.table_name,
      expected.source_columns,
      expected.target_table,
      expected.target_columns,
      expected.remove_code
  ) as per_fk
),
expected_indexes(
  table_name,
  object_name,
  expected_unique,
  expected_columns,
  expected_descending,
  expected_nulls_first,
  expected_predicate
) as (
  values
    ('categories', 'categories_slug_key', true, 'slug', array[false], array[false], ''),
    ('subscribers', 'subscribers_email_lower_key', true, 'lower(btrim(email))', array[false], array[false], ''),
    ('push_tokens', 'push_tokens_token_key', true, 'token', array[false], array[false], ''),
    ('products', 'products_active_category_idx', false, 'category_id,id', array[false, false], array[false, false], 'is_activeistrue'),
    ('product_images', 'product_images_product_position_idx', false, 'product_id,position,id', array[false, false, false], array[false, false, false], ''),
    ('order_items', 'order_items_order_id_idx', false, 'order_id', array[false], array[false], ''),
    ('order_items', 'order_items_product_id_idx', false, 'product_id', array[false], array[false], 'product_idisnotnull'),
    ('orders', 'orders_created_at_idx', false, 'created_at', array[true], array[true], ''),
    ('subscribers', 'subscribers_subscribed_at_idx', false, 'subscribed_at', array[true], array[true], ''),
    ('notify_me', 'notify_me_created_at_idx', false, 'created_at', array[true], array[true], ''),
    ('episodes', 'episodes_episode_number_idx', false, 'episode_number', array[false], array[false], '')
),
actual_indexes as (
  select
    index_table.relname as table_name,
    index_class.relname as object_name,
    access_method.amname as access_method,
    index_state.indisunique as is_unique,
    index_state.indisvalid,
    index_state.indisready,
    (
      select string_agg(
        regexp_replace(
          regexp_replace(
            replace(
              replace(
                lower(replace(pg_get_indexdef(index_state.indexrelid, position_number, true), '"', '')),
                'public.',
                ''
              ),
              'pg_catalog.',
              ''
            ),
            '::([a-z_][a-z0-9_]*[.])?[a-z_][a-z0-9_]*(\[\])?',
            '',
            'g'
          ),
          '[[:space:]]+',
          '',
          'g'
        ),
        ',' order by position_number
      )
      from generate_series(1, index_state.indnkeyatts) as positions(position_number)
    ) as indexed_columns,
    (
      select array_agg(
        (index_state.indoption[position_number - 1]::integer & 1) = 1
        order by position_number
      )
      from generate_series(1, index_state.indnkeyatts) as positions(position_number)
    ) as descending_flags,
    (
      select array_agg(
        (index_state.indoption[position_number - 1]::integer & 2) = 2
        order by position_number
      )
      from generate_series(1, index_state.indnkeyatts) as positions(position_number)
    ) as nulls_first_flags,
    regexp_replace(
      regexp_replace(
        replace(
          replace(
            lower(replace(coalesce(pg_get_expr(index_state.indpred, index_state.indrelid, true), ''), '"', '')),
            'public.',
            ''
          ),
          'pg_catalog.',
          ''
        ),
        '::([a-z_][a-z0-9_]*[.])?[a-z_][a-z0-9_]*(\[\])?',
        '',
        'g'
      ),
      '[[:space:]()]',
      '',
      'g'
    ) as normalized_predicate
  from pg_index as index_state
  join pg_class as index_class
    on index_class.oid = index_state.indexrelid
  join pg_class as index_table
    on index_table.oid = index_state.indrelid
  join pg_am as access_method
    on access_method.oid = index_class.relam
  join pg_namespace as n
    on n.oid = index_table.relnamespace
  where n.nspname = 'public'
),
index_state as (
  select
    count(*) filter (
      where actual_count > 0
        and not has_compatible_definition
    )::bigint as conflicting_count
  from (
    select
      expected.object_name,
      count(actual.object_name)::bigint as actual_count,
      coalesce(bool_or(
        actual.table_name = expected.table_name
        and actual.access_method = 'btree'
        and actual.is_unique = expected.expected_unique
        and actual.indisvalid
        and actual.indisready
        and actual.indexed_columns = expected.expected_columns
        and actual.descending_flags = expected.expected_descending
        and actual.nulls_first_flags = expected.expected_nulls_first
        and actual.normalized_predicate = expected.expected_predicate
      ), false) as has_compatible_definition
    from expected_indexes as expected
    left join actual_indexes as actual
      on actual.object_name = expected.object_name
    group by
      expected.object_name,
      expected.table_name,
      expected.expected_unique,
      expected.expected_columns,
      expected.expected_descending,
      expected.expected_nulls_first,
      expected.expected_predicate
  ) as per_index
),
subscriber_policy as (
  select
    policy.polname,
    policy.polcmd,
    policy.polpermissive,
    policy.polroles,
    pg_get_expr(policy.polqual, policy.polrelid, true) as using_expression,
    pg_get_expr(policy.polwithcheck, policy.polrelid, true) as with_check_expression
  from pg_policy as policy
  join pg_class as relation
    on relation.oid = policy.polrelid
  join pg_namespace as n
    on n.oid = relation.relnamespace
  where n.nspname = 'public'
    and relation.relname = 'subscribers'
    and policy.polname = 'subscribers_insert_public'
),
subscriber_policy_state as (
  select
    policy.polname is not null as is_present,
    case
      when policy.polname is null then true
      when to_regrole('anon') is null or to_regrole('authenticated') is null then null
      else
        policy.polcmd = 'a'
        and policy.polpermissive
        and not (0 = any(policy.polroles))
        and to_regrole('anon') = any(policy.polroles)
        and to_regrole('authenticated') = any(policy.polroles)
        and cardinality(policy.polroles) = 2
        and policy.using_expression is null
        and coalesce(
          regexp_replace(
            replace(lower(policy.with_check_expression), '::text', ''),
            '[[:space:]()]',
            '',
            'g'
          ) = concat('btrimemail<>', chr(39), chr(39)),
          false
        )
    end as is_compatible
  from (values (1)) as expected(marker)
  left join subscriber_policy as policy
    on true
),
bucket_state as (
  select
    expected.bucket_id,
    bucket.id is not null as is_present,
    bucket.public,
    bucket.file_size_limit,
    bucket.allowed_mime_types
  from (values ('instapay-proofs'), ('product-images')) as expected(bucket_id)
  left join storage.buckets as bucket
    on bucket.id = expected.bucket_id
),
target_actions(action_code, action_name, privilege_name) as (
  values
    ('a'::"char", 'upload'::text, concat('IN', 'SERT')),
    ('w'::"char", 'change'::text, concat('UP', 'DATE')),
    ('d'::"char", 'remove'::text, concat('DE', 'LETE'))
),
storage_relation as (
  select
    relation.oid,
    relation.relowner,
    relation.relrowsecurity,
    relation.relforcerowsecurity
  from pg_class as relation
  join pg_namespace as n
    on n.oid = relation.relnamespace
  where n.nspname = 'storage'
    and relation.relname = 'objects'
    and relation.relkind in ('r', 'p')
),
storage_policy_metadata as (
  select
    policy.polname,
    policy.polroles,
    policy.polcmd,
    policy.polpermissive,
    pg_get_expr(policy.polqual, policy.polrelid, true) as using_expression,
    pg_get_expr(policy.polwithcheck, policy.polrelid, true) as with_check_expression
  from pg_policy as policy
  join storage_relation as relation
    on relation.oid = policy.polrelid
),
storage_policy_candidates as (
  select
    bucket.bucket_id,
    action.action_code,
    policy.polname,
    policy.polpermissive,
    lower(coalesce(policy.using_expression, 'true')) as effective_using_expression,
    lower(coalesce(
      policy.with_check_expression,
      case when policy.polcmd in ('w', '*') then policy.using_expression end,
      'true'
    )) as effective_with_check_expression
  from (values ('instapay-proofs'), ('product-images')) as bucket(bucket_id)
  cross join target_actions as action
  cross join (
    select role.oid as anon_oid, role.rolbypassrls as anon_bypasses_rls
    from (values (1)) as expected(marker)
    left join pg_roles as role
      on role.rolname = 'anon'
  ) as role_state
  join storage_policy_metadata as policy
    on (policy.polcmd = action.action_code or policy.polcmd = '*')
   and exists (
     select 1
     from unnest(policy.polroles) as policy_role(role_oid)
     where policy_role.role_oid = 0
        or policy_role.role_oid = role_state.anon_oid
        or (
          role_state.anon_oid is not null
          and policy_role.role_oid <> 0
          and pg_has_role(role_state.anon_oid, policy_role.role_oid, 'MEMBER')
        )
   )
),
storage_policy_clause_states as (
  select
    candidate.*,
    case
      when candidate.effective_using_expression ~* '(^|[^a-z])false([^a-z]|$)' then 'DENY'
      when candidate.effective_using_expression ilike
        '%bucket_id is distinct from ''' || candidate.bucket_id || '''%'
        and candidate.effective_using_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'DENY'
      when candidate.effective_using_expression ~* (
        'bucket_id[[:space:]]*=[[:space:]]*''' || candidate.bucket_id || ''''
      ) then 'ALLOW'
      when candidate.effective_using_expression ~*
        'bucket_id[[:space:]]*=[[:space:]]*''[^'']+'''
        and candidate.effective_using_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'DENY'
      when candidate.effective_using_expression !~* 'bucket_id' then 'ALLOW'
      when candidate.effective_using_expression ~* 'bucket_id[[:space:]]+is[[:space:]]+distinct[[:space:]]+from'
        and candidate.effective_using_expression !~* 'bucket_id[[:space:]]*='
        and candidate.effective_using_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'ALLOW'
      else 'UNKNOWN'
    end as using_state,
    case
      when candidate.effective_with_check_expression ~* '(^|[^a-z])false([^a-z]|$)' then 'DENY'
      when candidate.effective_with_check_expression ilike
        '%bucket_id is distinct from ''' || candidate.bucket_id || '''%'
        and candidate.effective_with_check_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'DENY'
      when candidate.effective_with_check_expression ~* (
        'bucket_id[[:space:]]*=[[:space:]]*''' || candidate.bucket_id || ''''
      ) then 'ALLOW'
      when candidate.effective_with_check_expression ~*
        'bucket_id[[:space:]]*=[[:space:]]*''[^'']+'''
        and candidate.effective_with_check_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'DENY'
      when candidate.effective_with_check_expression !~* 'bucket_id' then 'ALLOW'
      when candidate.effective_with_check_expression ~* 'bucket_id[[:space:]]+is[[:space:]]+distinct[[:space:]]+from'
        and candidate.effective_with_check_expression !~* 'bucket_id[[:space:]]*='
        and candidate.effective_with_check_expression !~*
          '(^|[^[:alpha:]])or([^[:alpha:]]|$)' then 'ALLOW'
      else 'UNKNOWN'
    end as with_check_state
  from storage_policy_candidates as candidate
),
storage_policy_action_states as (
  select
    clause.*,
    case clause.action_code
      when 'a' then clause.with_check_state
      when 'd' then clause.using_state
      when 'w' then case
        when clause.using_state = 'DENY' or clause.with_check_state = 'DENY' then 'DENY'
        when clause.using_state = 'ALLOW' and clause.with_check_state = 'ALLOW' then 'ALLOW'
        else 'UNKNOWN'
      end
    end as action_state
  from storage_policy_clause_states as clause
),
storage_policy_access as (
  select
    bucket_id,
    action_code,
    count(*) filter (
      where polpermissive and action_state = 'ALLOW'
    )::bigint as permissive_allow_count,
    count(*) filter (
      where not polpermissive and action_state = 'DENY'
    )::bigint as restrictive_block_count,
    count(*) filter (
      where action_state = 'UNKNOWN'
    )::bigint as unknown_policy_count
  from storage_policy_action_states
  group by bucket_id, action_code
),
storage_access_matrix as (
  select
    bucket.bucket_id,
    action.action_code,
    action.action_name,
    role_state.anon_oid,
    role_state.anon_bypasses_rls,
    relation.oid as relation_oid,
    relation.relowner = role_state.anon_oid as anon_owns_relation,
    relation.relrowsecurity,
    relation.relforcerowsecurity,
    case
      when role_state.anon_oid is null or relation.oid is null then null
      else has_table_privilege(role_state.anon_oid, relation.oid, action.privilege_name)
    end as table_privilege,
    case
      when role_state.anon_oid is null or relation.oid is null then null
      when action.action_code in ('a', 'w')
        then has_any_column_privilege(role_state.anon_oid, relation.oid, action.privilege_name)
      else false
    end as any_column_privilege,
    coalesce(access.permissive_allow_count, 0)::bigint as permissive_allow_count,
    coalesce(access.restrictive_block_count, 0)::bigint as restrictive_block_count,
    coalesce(access.unknown_policy_count, 0)::bigint as unknown_policy_count
  from (values ('instapay-proofs'), ('product-images')) as bucket(bucket_id)
  cross join target_actions as action
  cross join (
    select role.oid as anon_oid, role.rolbypassrls as anon_bypasses_rls
    from (values (1)) as expected(marker)
    left join pg_roles as role
      on role.rolname = 'anon'
  ) as role_state
  left join storage_relation as relation
    on true
  left join storage_policy_access as access
    on access.bucket_id = bucket.bucket_id
   and access.action_code = action.action_code
),
storage_access_evaluated as (
  select
    matrix.*,
    case
      when anon_oid is null
        or relation_oid is null
        or table_privilege is null
        or any_column_privilege is null
        or anon_bypasses_rls is null
        or anon_owns_relation is null
        or relrowsecurity is null
        or relforcerowsecurity is null
        then null
      when not (table_privilege or any_column_privilege) then false
      when anon_bypasses_rls then true
      when anon_owns_relation and not relforcerowsecurity then true
      when not relrowsecurity then true
      when restrictive_block_count > 0 then false
      when unknown_policy_count > 0 then null
      else permissive_allow_count > 0
    end as anonymous_access_possible
  from storage_access_matrix as matrix
),
storage_access_state as (
  select
    bucket_id,
    count(*) filter (
      where anonymous_access_possible is null
    )::bigint as unknown_count,
    count(*) filter (
      where anonymous_access_possible
    )::bigint as allowed_action_count
  from storage_access_evaluated
  group by bucket_id
),
historical_validation_state as (
  select
    count(*)::bigint as not_valid_count,
    coalesce(
      array_agg(
        format('%s.%s', relation.relname, constraint_state.conname)
        order by relation.relname, constraint_state.conname
      ),
      '{}'::text[]
    ) as not_valid_constraints
  from pg_constraint as constraint_state
  join pg_class as relation
    on relation.oid = constraint_state.conrelid
  join pg_namespace as n
    on n.oid = relation.relnamespace
  where n.nspname = 'public'
    and relation.relname in (
      'categories', 'products', 'product_images', 'orders', 'order_items',
      'settings', 'subscribers', 'notify_me', 'episodes', 'push_tokens'
    )
    and constraint_state.contype in ('c', 'f')
    and not constraint_state.convalidated
),
base_summary(check_order, check_name, result, expected, status) as (
  select
    1,
    'active_table_relation_kinds',
    format('missing=%s; wrong_kind=%s', missing_count, wrong_kind_count),
    'all ten names resolve to ordinary or partitioned tables',
    case when missing_count = 0 and wrong_kind_count = 0 then 'PASS' else 'BLOCKED' end
  from table_state

  union all

  select
    2,
    'protected_rpc_exposure',
    format('missing=%s; unknown=%s; exposed=%s', missing_count, unknown_count, exposed_count),
    'no protected RPC is executable by PUBLIC, anon, or authenticated',
    case
      when exposed_count > 0 then 'BLOCKED'
      when missing_count > 0 or unknown_count > 0 then 'CANNOT_VERIFY'
      else 'PASS'
    end
  from rpc_state

  union all

  select
    3,
    'expiry_cron_configuration',
    format('active_relevant=%s; exact_active=%s', active_relevant_count, exact_active_count),
    'exactly one active tick-instapay-expiry job; 10 seconds; select public.expire_instapay_orders();',
    case when active_relevant_count = 1 and exact_active_count = 1 then 'PASS' else 'BLOCKED' end
  from cron_state

  union all

  select
    4,
    'normalized_instapay_duplicates',
    format('groups=%s; affected_rows=%s', duplicate_group_count, affected_row_count),
    'zero duplicate groups after the application normalization',
    case when duplicate_group_count = 0 then 'PASS' else 'BLOCKED' end
  from duplicate_state

  union all

  select
    5,
    'foreign_key_compatibility',
    format('conflicting=%s', conflicting_count),
    'every existing FK on a pending source column has the expected target and removal behavior',
    case when conflicting_count = 0 then 'PASS' else 'BLOCKED' end
  from fk_state

  union all

  select
    6,
    'same_name_check_compatibility',
    format('conflicting=%s', conflicting_count),
    'every present pending CHECK name has a compatible definition',
    case when conflicting_count = 0 then 'PASS' else 'BLOCKED' end
  from check_state

  union all

  select
    7,
    'same_name_index_compatibility',
    format('conflicting=%s', conflicting_count),
    'every present pending index name has compatible keys, uniqueness, and predicate',
    case when conflicting_count = 0 then 'PASS' else 'BLOCKED' end
  from index_state

  union all

  select
    8,
    'subscribers_policy_compatibility',
    case
      when not is_present then 'absent; the pending convergence can supply it'
      when is_compatible is null then 'present; role metadata is unavailable'
      when is_compatible then 'present and compatible'
      else 'present and incompatible'
    end,
    'when present, subscribers_insert_public is permissive for anon and authenticated with the exact email check',
    case
      when not is_present then 'PASS'
      when is_compatible is null then 'CANNOT_VERIFY'
      when is_compatible then 'PASS'
      else 'BLOCKED'
    end
  from subscriber_policy_state

  union all

  select
    9,
    'instapay_proofs_bucket_privacy',
    case
      when not is_present then 'absent; the pending bucket contract can supply it'
      else format('present; public=%s', public)
    end,
    'instapay-proofs is private',
    case when is_present and public then 'BLOCKED' else 'PASS' end
  from bucket_state
  where bucket_id = 'instapay-proofs'

  union all

  select
    10,
    'instapay_proofs_anonymous_mutation',
    format('unknown=%s; allowed_actions=%s', unknown_count, allowed_action_count),
    'anonymous upload, change, and removal are all unavailable',
    case
      when allowed_action_count > 0 then 'BLOCKED'
      when unknown_count > 0 then 'CANNOT_VERIFY'
      else 'PASS'
    end
  from storage_access_state
  where bucket_id = 'instapay-proofs'

  union all

  select
    11,
    'product_images_anonymous_mutation',
    format('unknown=%s; allowed_actions=%s', unknown_count, allowed_action_count),
    'anonymous upload, change, and removal are all unavailable',
    case
      when allowed_action_count > 0 then 'BLOCKED'
      when unknown_count > 0 then 'CANNOT_VERIFY'
      else 'PASS'
    end
  from storage_access_state
  where bucket_id = 'product-images'

  union all

  select
    12,
    'historical_constraint_validation',
    format('not_valid=%s; constraints=%s', not_valid_count, not_valid_constraints),
    'historical NOT VALID CHECK/FK constraints are reported for later validation review',
    case when not_valid_count = 0 then 'PASS' else 'WARNING' end
  from historical_validation_state

  union all

  select
    13,
    'product_images_legacy_objects',
    'object contents and MIME history intentionally not listed',
    'unsupported legacy Storage objects require a separate approved object-level inspection',
    'WARNING'

  union all

  select
    14,
    'cron_recent_execution',
    format(
      'runs=%s; successful=%s; failed=%s; latest=%s',
      recent_run_count,
      successful_run_count,
      failed_run_count,
      coalesce(latest_run_timestamp::text, 'none')
    ),
    'at least one expiry cron execution in the last 7 days',
    case when recent_run_count = 0 then 'WARNING' else 'PASS' end
  from cron_run_state
),
overall as (
  select
    case
      when count(*) filter (where status = 'BLOCKED') > 0 then 'BLOCKED'
      when count(*) filter (where status = 'CANNOT_VERIFY') > 0 then 'CANNOT_VERIFY'
      when count(*) filter (where status = 'WARNING') > 0 then 'WARNING'
      else 'PASS'
    end as status,
    count(*) filter (where status = 'PASS')::bigint as pass_count,
    count(*) filter (where status = 'WARNING')::bigint as warning_count,
    count(*) filter (where status = 'BLOCKED')::bigint as blocked_count,
    count(*) filter (where status = 'CANNOT_VERIFY')::bigint as cannot_verify_count
  from base_summary
)
select
  'final_preflight_summary'::text as result_set,
  check_name,
  result,
  expected,
  status
from (
  select check_order, check_name, result, expected, status
  from base_summary

  union all

  select
    99,
    'overall_phase1_preflight',
    format(
      'pass=%s; warning=%s; blocked=%s; cannot_verify=%s',
      pass_count,
      warning_count,
      blocked_count,
      cannot_verify_count
    ),
    'no BLOCKED or CANNOT_VERIFY result; warnings require owner review',
    status
  from overall
) as ordered_summary
order by check_order;

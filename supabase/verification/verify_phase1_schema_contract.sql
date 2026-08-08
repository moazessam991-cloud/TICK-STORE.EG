-- Read-only Phase 1 schema-contract verification.
-- Safe for catalog inspection: this file contains SELECT statements only and
-- does not inspect application rows, customer data or Storage object contents.

-- 1-2. Required active relations and columns/types.
with expected(table_name, column_name, expected_udt) as (
  values
    ('categories', 'id', 'uuid'),
    ('categories', 'name', 'text'),
    ('categories', 'slug', 'text'),
    ('categories', 'description', 'text'),
    ('categories', 'image_url', 'text'),
    ('categories', 'created_at', 'timestamptz'),
    ('products', 'id', 'uuid'),
    ('products', 'category_id', 'uuid'),
    ('products', 'brand', 'text'),
    ('products', 'name', 'text'),
    ('products', 'price', 'numeric'),
    ('products', 'sale_price', 'numeric'),
    ('products', 'emoji', 'text'),
    ('products', 'bg_color', 'text'),
    ('products', 'tags', '_text'),
    ('products', 'size', 'text'),
    ('products', 'movement', 'text'),
    ('products', 'case_size', 'text'),
    ('products', 'crystal', 'text'),
    ('products', 'water_resistance', 'text'),
    ('products', 'strap_type', 'text'),
    ('products', 'power_reserve', 'text'),
    ('products', 'stock_quantity', 'int4'),
    ('products', 'description_en', 'text'),
    ('products', 'description_ar', 'text'),
    ('products', 'video_url', 'text'),
    ('products', 'model_3d_url', 'text'),
    ('products', 'force_out_of_stock', 'bool'),
    ('products', 'is_active', 'bool'),
    ('products', 'variants', 'jsonb'),
    ('products', 'era', 'text'),
    ('products', 'condition_rating', 'int2'),
    ('products', 'orig_price_reference', 'numeric'),
    ('products', 'authentication_notes', 'text'),
    ('products', 'created_at', 'timestamptz'),
    ('products', 'updated_at', 'timestamptz'),
    ('product_images', 'id', 'uuid'),
    ('product_images', 'product_id', 'uuid'),
    ('product_images', 'url', 'text'),
    ('product_images', 'position', 'int4'),
    ('product_images', 'storage_path', 'text'),
    ('product_images', 'created_at', 'timestamptz'),
    ('orders', 'id', 'uuid'),
    ('orders', 'status', 'text'),
    ('orders', 'total_amount', 'numeric'),
    ('orders', 'payment_method', 'text'),
    ('orders', 'payment_status', 'text'),
    ('orders', 'payment_id', 'text'),
    ('orders', 'customer_name', 'text'),
    ('orders', 'customer_phone', 'text'),
    ('orders', 'customer_email', 'text'),
    ('orders', 'shipping_address', 'jsonb'),
    ('orders', 'notes', 'text'),
    ('orders', 'checkout_token', 'text'),
    ('orders', 'payment_reference', 'text'),
    ('orders', 'payment_sender_name', 'text'),
    ('orders', 'payment_proof_path', 'text'),
    ('orders', 'payment_expires_at', 'timestamptz'),
    ('orders', 'payment_submitted_at', 'timestamptz'),
    ('orders', 'payment_verified_at', 'timestamptz'),
    ('orders', 'payment_verified_by', 'text'),
    ('orders', 'payment_rejected_at', 'timestamptz'),
    ('orders', 'payment_rejection_reason', 'text'),
    ('orders', 'stock_restored_at', 'timestamptz'),
    ('orders', 'created_at', 'timestamptz'),
    ('orders', 'updated_at', 'timestamptz'),
    ('order_items', 'id', 'uuid'),
    ('order_items', 'order_id', 'uuid'),
    ('order_items', 'product_id', 'uuid'),
    ('order_items', 'quantity', 'int4'),
    ('order_items', 'price_at_purchase', 'numeric'),
    ('order_items', 'metadata', 'jsonb'),
    ('order_items', 'created_at', 'timestamptz'),
    ('settings', 'key', 'text'),
    ('settings', 'value', 'jsonb'),
    ('settings', 'updated_at', 'timestamptz'),
    ('subscribers', 'id', 'uuid'),
    ('subscribers', 'email', 'text'),
    ('subscribers', 'source', 'text'),
    ('subscribers', 'subscribed_at', 'timestamptz'),
    ('notify_me', 'id', 'uuid'),
    ('notify_me', 'product_id', 'uuid'),
    ('notify_me', 'email', 'text'),
    ('notify_me', 'phone', 'text'),
    ('notify_me', 'contact_raw', 'text'),
    ('notify_me', 'created_at', 'timestamptz'),
    ('episodes', 'id', 'uuid'),
    ('episodes', 'episode_number', 'int4'),
    ('episodes', 'title_en', 'text'),
    ('episodes', 'title_ar', 'text'),
    ('episodes', 'description_en', 'text'),
    ('episodes', 'description_ar', 'text'),
    ('episodes', 'category', 'text'),
    ('episodes', 'duration', 'text'),
    ('episodes', 'video_url', 'text'),
    ('episodes', 'created_at', 'timestamptz'),
    ('push_tokens', 'id', 'uuid'),
    ('push_tokens', 'token', 'text'),
    ('push_tokens', 'device_name', 'text'),
    ('push_tokens', 'platform', 'text'),
    ('push_tokens', 'last_seen', 'timestamptz'),
    ('push_tokens', 'created_at', 'timestamptz')
), missing as (
  select e.*,
         c.udt_name as actual_udt
    from expected as e
    left join information_schema.columns as c
      on c.table_schema = 'public'
     and c.table_name = e.table_name
     and c.column_name = e.column_name
   where c.column_name is null
      or c.udt_name <> e.expected_udt
)
select
  'required_active_columns' as check_name,
  count(*) = 0 as ok,
  coalesce(
    string_agg(
      format('%I.%I expected %s found %s', table_name, column_name, expected_udt, coalesce(actual_udt, 'missing')),
      '; ' order by table_name, column_name
    ),
    'all required active columns have the expected type'
  ) as detail
from missing;

-- Legacy tables may still exist on an upgraded project, but they are not part
-- of the clean-install baseline. Their presence here is informational only.
select
  'legacy_objects_are_not_baseline_dependencies' as check_name,
  true as ok,
  'profiles,carts,cart_items,wishlist,reviews,coupons,banners,straps,audit_log,customers,archive,payment_events,webhook_events are excluded by the source contract test' as detail;

-- 3. Primary keys.
with expected(table_name) as (
  values
    ('categories'), ('products'), ('product_images'), ('orders'),
    ('order_items'), ('settings'), ('subscribers'), ('notify_me'),
    ('episodes'), ('push_tokens')
), missing as (
  select e.table_name
    from expected as e
   where not exists (
     select 1
       from pg_constraint as c
      where c.conrelid = format('public.%I', e.table_name)::regclass
        and c.contype = 'p'
   )
)
select
  'active_primary_keys' as check_name,
  count(*) = 0 as ok,
  coalesce(string_agg(table_name, ', ' order by table_name), 'all active tables have a primary key') as detail
from missing;

-- 4. Required foreign keys and delete behavior.
with expected(check_name, source_table, source_column, target_table, target_column, delete_code) as (
  values
    ('products.category_id -> categories.id', 'products', 'category_id', 'categories', 'id', 'a'::"char"),
    ('product_images.product_id -> products.id', 'product_images', 'product_id', 'products', 'id', 'c'::"char"),
    ('order_items.order_id -> orders.id', 'order_items', 'order_id', 'orders', 'id', 'c'::"char"),
    ('order_items.product_id -> products.id', 'order_items', 'product_id', 'products', 'id', 'n'::"char"),
    ('notify_me.product_id -> products.id', 'notify_me', 'product_id', 'products', 'id', 'c'::"char")
), resolved as (
  select e.*,
         source_attribute.attnum as source_attnum,
         target_attribute.attnum as target_attnum
    from expected as e
    left join pg_attribute as source_attribute
      on source_attribute.attrelid = format('public.%I', e.source_table)::regclass
     and source_attribute.attname = e.source_column
     and not source_attribute.attisdropped
    left join pg_attribute as target_attribute
      on target_attribute.attrelid = format('public.%I', e.target_table)::regclass
     and target_attribute.attname = e.target_column
     and not target_attribute.attisdropped
), missing as (
  select e.check_name
    from resolved as e
   where not exists (
     select 1
       from pg_constraint as c
      where c.conrelid = format('public.%I', e.source_table)::regclass
        and c.confrelid = format('public.%I', e.target_table)::regclass
        and c.contype = 'f'
        and c.confdeltype = e.delete_code
        and c.conkey = array[e.source_attnum]
        and c.confkey = array[e.target_attnum]
   )
)
select
  'active_foreign_keys' as check_name,
  count(*) = 0 as ok,
  coalesce(string_agg(check_name, ', ' order by check_name), 'all required foreign keys match') as detail
from missing;

-- 5. Required indexes.
with expected(index_name) as (
  values
    ('categories_slug_key'),
    ('subscribers_email_lower_key'),
    ('push_tokens_token_key'),
    ('products_active_category_idx'),
    ('product_images_product_position_idx'),
    ('order_items_order_id_idx'),
    ('order_items_product_id_idx'),
    ('orders_checkout_token_key'),
    ('orders_instapay_payment_reference_key'),
    ('orders_instapay_expiry_due_idx'),
    ('orders_created_at_idx'),
    ('subscribers_subscribed_at_idx'),
    ('notify_me_created_at_idx'),
    ('episodes_episode_number_idx')
), missing as (
  select e.index_name
    from expected as e
   where not exists (
     select 1
       from pg_indexes as i
      where i.schemaname = 'public'
        and i.indexname = e.index_name
   )
)
select
  'active_indexes' as check_name,
  count(*) = 0 as ok,
  coalesce(string_agg(index_name, ', ' order by index_name), 'all required indexes exist') as detail
from missing;

-- 6. RLS on every active table.
with expected(table_name) as (
  values
    ('categories'), ('products'), ('product_images'), ('orders'),
    ('order_items'), ('settings'), ('subscribers'), ('notify_me'),
    ('episodes'), ('push_tokens')
), missing as (
  select e.table_name
    from expected as e
    left join pg_class as c
      on c.oid = format('public.%I', e.table_name)::regclass
   where c.relrowsecurity is not true
)
select
  'active_table_rls' as check_name,
  count(*) = 0 as ok,
  coalesce(string_agg(table_name, ', ' order by table_name), 'RLS is enabled on every active table') as detail
from missing;

-- 7. Anonymous table/column privileges. Policies are listed immediately after.
select
  'anonymous_grant_matrix' as check_name,
  has_table_privilege('anon', 'public.categories', 'SELECT')
  and has_table_privilege('anon', 'public.products', 'SELECT')
  and has_table_privilege('anon', 'public.product_images', 'SELECT')
  and has_table_privilege('anon', 'public.episodes', 'SELECT')
  and has_table_privilege('anon', 'public.settings', 'SELECT')
  and not has_table_privilege('anon', 'public.orders', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('anon', 'public.order_items', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('anon', 'public.push_tokens', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('anon', 'public.subscribers', 'SELECT')
  and has_column_privilege('anon', 'public.subscribers', 'email', 'INSERT')
  and has_column_privilege('anon', 'public.subscribers', 'source', 'INSERT')
  and not has_table_privilege('anon', 'public.notify_me', 'SELECT')
  and has_column_privilege('anon', 'public.notify_me', 'product_id', 'INSERT')
  and has_column_privilege('anon', 'public.notify_me', 'contact_raw', 'INSERT') as ok,
  'anon reads public catalog/settings, inserts subscriber/notify columns, and has no protected-table access' as detail;

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'categories', 'products', 'product_images', 'orders', 'order_items',
    'settings', 'subscribers', 'notify_me', 'episodes', 'push_tokens'
  )
order by tablename, policyname;

-- 8. External business RPCs must be service-role only.
with expected(signature) as (
  values
    ('public.create_order_with_stock(jsonb,jsonb)'),
    ('public.adjust_product_stock(uuid,integer)'),
    ('public.get_instapay_order_for_customer(uuid,text)'),
    ('public.submit_instapay_payment_proof(uuid,text,text,text,text)'),
    ('public.confirm_instapay_payment(uuid,text)'),
    ('public.reject_instapay_payment(uuid,text)'),
    ('public.expire_instapay_orders()'),
    ('public.cancel_order_with_stock(uuid,text)'),
    ('public.update_order_fulfillment_status(uuid,text)'),
    ('public.confirm_card_payment(uuid,text,numeric)')
), resolved as (
  select e.signature,
         to_regprocedure(e.signature) as function_oid
    from expected as e
), checked as (
  select r.signature,
         r.function_oid is not null as function_exists,
         case when r.function_oid is null then false
              else has_function_privilege('service_role', r.function_oid, 'EXECUTE') end as service_execute,
         case when r.function_oid is null then true
              else has_function_privilege('anon', r.function_oid, 'EXECUTE') end as anon_execute,
         case when r.function_oid is null then true
              else has_function_privilege('authenticated', r.function_oid, 'EXECUTE') end as authenticated_execute,
         case when r.function_oid is null then true
              else exists (
                select 1
                  from pg_proc as p,
                       lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
                 where p.oid = r.function_oid
                   and acl.grantee = 0
                   and acl.privilege_type = 'EXECUTE'
              ) end as public_execute
    from resolved as r
)
select
  'service_role_only_rpcs' as check_name,
  bool_and(function_exists and service_execute and not anon_execute and not authenticated_execute and not public_execute) as ok,
  string_agg(
    format('%s exists=%s service=%s anon=%s authenticated=%s public=%s',
      signature, function_exists, service_execute, anon_execute, authenticated_execute, public_execute),
    '; ' order by signature
  ) as detail
from checked;

-- 9-10. Bucket definitions only; no Storage object data is read.
with expected(id, expected_public, expected_limit) as (
  values
    ('instapay-proofs', false, 5242880::bigint),
    ('product-images', true, 5242880::bigint)
), checked as (
  select e.id,
         b.id is not null
         and b.public = e.expected_public
         and b.file_size_limit = e.expected_limit
         and b.allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']::text[]
         and b.allowed_mime_types <@ array['image/jpeg', 'image/png', 'image/webp']::text[] as ok
    from expected as e
    left join storage.buckets as b on b.id = e.id
)
select
  'storage_bucket_contracts' as check_name,
  bool_and(ok) as ok,
  string_agg(format('%s=%s', id, ok), ', ' order by id) as detail
from checked;

-- 11. Exactly one active expiry job with the expected schedule and command.
select
  'single_instapay_expiry_cron' as check_name,
  count(*) = 1
  and bool_and(
    jobname = 'tick-instapay-expiry'
    and schedule = '10 seconds'
    and command = 'select public.expire_instapay_orders();'
    and active is true
  ) as ok,
  format('%s matching job(s)', count(*)) as detail
from cron.job
where jobname = 'tick-instapay-expiry'
   or position('expire_instapay_orders' in lower(command)) > 0;

-- Constraint validation state. Forward-added checks/FKs are intentionally
-- NOT VALID in Phase 1; a clean baseline's constraints are already validated.
select
  c.conrelid::regclass as relation,
  c.conname as constraint_name,
  c.contype as constraint_type,
  c.convalidated as validated,
  pg_get_constraintdef(c.oid, true) as definition
from pg_constraint as c
where c.connamespace = 'public'::regnamespace
  and c.conname in (
    'categories_slug_not_blank',
    'products_price_nonnegative',
    'products_sale_price_valid',
    'products_stock_nonnegative',
    'products_condition_rating_range',
    'products_original_price_nonnegative',
    'products_variants_shape',
    'product_images_position_nonnegative',
    'orders_total_nonnegative',
    'orders_status_check',
    'order_items_quantity_positive',
    'order_items_price_nonnegative',
    'subscribers_email_not_blank',
    'notify_me_contact_present',
    'push_tokens_token_not_blank',
    'products_category_id_fkey',
    'product_images_product_id_fkey',
    'order_items_order_id_fkey',
    'order_items_product_id_fkey',
    'notify_me_product_id_fkey',
    'orders_instapay_payment_status_check',
    'orders_instapay_expiry_required_check'
  )
order by relation::text, constraint_name;

-- 12. Migration source ordering and legacy exclusions are checked without a
-- database by: npm run test:migrations
select
  'migration_source_dependency_order' as check_name,
  true as ok,
  'run npm run test:migrations against the same checkout' as detail;

-- Essential active-schema constraints and runtime-backed indexes.
-- Historical rows are never rewritten here. CHECK and foreign-key constraints
-- added to an existing project remain NOT VALID until a later reviewed phase.

do $primary_keys$
declare
  v_table record;
begin
  for v_table in
    select table_name
      from (values
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
      ) as required(table_name)
  loop
    if not exists (
      select 1
        from pg_constraint
       where conrelid = format('public.%I', v_table.table_name)::regclass
         and contype = 'p'
    ) then
      raise exception using message = format(
        'phase1_missing_primary_key: public.%s requires a reviewed primary key',
        v_table.table_name
      );
    end if;
  end loop;
end
$primary_keys$;

do $check_constraints$
declare
  v_check record;
  v_type "char";
begin
  for v_check in
    select table_name, constraint_name, definition
      from (values
        ('categories', 'categories_slug_not_blank',
          'check (btrim(slug) <> '''')'),
        ('products', 'products_price_nonnegative',
          'check (price >= 0)'),
        ('products', 'products_sale_price_valid',
          'check (sale_price is null or (sale_price >= 0 and sale_price < price))'),
        ('products', 'products_stock_nonnegative',
          'check (stock_quantity >= 0)'),
        -- condition_rating is canonically smallint; its accepted range is unchanged.
        ('products', 'products_condition_rating_range',
          'check (condition_rating is null or condition_rating between 1 and 5)'),
        ('products', 'products_original_price_nonnegative',
          'check (orig_price_reference is null or orig_price_reference >= 0)'),
        ('products', 'products_variants_shape',
          'check (variants is null or jsonb_typeof(variants) in (''array'', ''object''))'),
        ('product_images', 'product_images_position_nonnegative',
          'check (position >= 0)'),
        ('orders', 'orders_total_nonnegative',
          'check (total_amount >= 0)'),
        ('orders', 'orders_status_check',
          'check (status in (''pending'', ''confirmed'', ''shipped'', ''delivered'', ''cancelled'', ''refunded''))'),
        ('order_items', 'order_items_quantity_positive',
          'check (quantity > 0)'),
        ('order_items', 'order_items_price_nonnegative',
          'check (price_at_purchase >= 0)'),
        ('subscribers', 'subscribers_email_not_blank',
          'check (btrim(email) <> '''')'),
        ('notify_me', 'notify_me_contact_present',
          'check (nullif(btrim(email), '''') is not null or nullif(btrim(phone), '''') is not null)'),
        ('push_tokens', 'push_tokens_token_not_blank',
          'check (btrim(token) <> '''')')
      ) as expected(table_name, constraint_name, definition)
  loop
    select c.contype
      into v_type
      from pg_constraint as c
     where c.conname = v_check.constraint_name
       and c.conrelid = format('public.%I', v_check.table_name)::regclass;

    if found then
      if v_type <> 'c' then
        raise exception using message = format(
          'phase1_incompatible_constraint: public.%s.%s is not a CHECK constraint',
          v_check.table_name,
          v_check.constraint_name
        );
      end if;
    else
      execute format(
        'alter table public.%I add constraint %I %s not valid',
        v_check.table_name,
        v_check.constraint_name,
        v_check.definition
      );
    end if;
  end loop;
end
$check_constraints$;

do $foreign_keys$
declare
  v_fk record;
  v_source_attribute smallint;
  v_target_attribute smallint;
  v_has_expected boolean;
  v_has_other boolean;
begin
  for v_fk in
    select table_name, column_name, constraint_name,
           target_table, target_column, delete_code, delete_sql
      from (values
        ('products', 'category_id', 'products_category_id_fkey',
          'categories', 'id', 'a', 'no action'),
        ('product_images', 'product_id', 'product_images_product_id_fkey',
          'products', 'id', 'c', 'cascade'),
        ('order_items', 'order_id', 'order_items_order_id_fkey',
          'orders', 'id', 'c', 'cascade'),
        ('order_items', 'product_id', 'order_items_product_id_fkey',
          'products', 'id', 'n', 'set null'),
        ('notify_me', 'product_id', 'notify_me_product_id_fkey',
          'products', 'id', 'c', 'cascade')
      ) as expected(
        table_name,
        column_name,
        constraint_name,
        target_table,
        target_column,
        delete_code,
        delete_sql
      )
  loop
    select a.attnum
      into v_source_attribute
      from pg_attribute as a
     where a.attrelid = format('public.%I', v_fk.table_name)::regclass
       and a.attname = v_fk.column_name
       and not a.attisdropped;

    select a.attnum
      into v_target_attribute
      from pg_attribute as a
     where a.attrelid = format('public.%I', v_fk.target_table)::regclass
       and a.attname = v_fk.target_column
       and not a.attisdropped;

    if v_source_attribute is null or v_target_attribute is null then
      raise exception using message = format(
        'phase1_foreign_key_column_missing: public.%s.%s -> public.%s.%s',
        v_fk.table_name,
        v_fk.column_name,
        v_fk.target_table,
        v_fk.target_column
      );
    end if;

    select exists (
      select 1
        from pg_constraint as c
       where c.contype = 'f'
         and c.conrelid = format('public.%I', v_fk.table_name)::regclass
         and c.confrelid = format('public.%I', v_fk.target_table)::regclass
         and c.conkey = array[v_source_attribute]
         and c.confkey = array[v_target_attribute]
         and c.confdeltype = v_fk.delete_code::"char"
    ) into v_has_expected;

    select exists (
      select 1
        from pg_constraint as c
       where c.contype = 'f'
         and c.conrelid = format('public.%I', v_fk.table_name)::regclass
         and c.conkey = array[v_source_attribute]
    ) into v_has_other;

    if v_has_other and not v_has_expected then
      raise exception using message = format(
        'phase1_incompatible_foreign_key: public.%s.%s has a different foreign key',
        v_fk.table_name,
        v_fk.column_name
      );
    end if;

    if not v_has_expected then
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references public.%I(%I) on delete %s not valid',
        v_fk.table_name,
        v_fk.constraint_name,
        v_fk.column_name,
        v_fk.target_table,
        v_fk.target_column,
        v_fk.delete_sql
      );
    end if;
  end loop;
end
$foreign_keys$;

do $unique_prechecks$
begin
  if exists (
    select 1
      from public.categories
     where slug is not null
     group by slug
    having count(*) > 1
  ) then
    raise exception using message =
      'phase1_duplicate_category_slug: resolve duplicates before creating the unique index';
  end if;

  if exists (
    select 1
      from public.subscribers
     where email is not null
     group by lower(btrim(email))
    having count(*) > 1
  ) then
    raise exception using message =
      'phase1_duplicate_subscriber_email: resolve case-insensitive duplicates before creating the unique index';
  end if;

  if exists (
    select 1
      from public.push_tokens
     where token is not null
     group by token
    having count(*) > 1
  ) then
    raise exception using message =
      'phase1_duplicate_push_token: resolve duplicates before creating the unique index';
  end if;
end
$unique_prechecks$;

create unique index if not exists categories_slug_key
  on public.categories (slug);

create unique index if not exists subscribers_email_lower_key
  on public.subscribers (lower(btrim(email)));

create unique index if not exists push_tokens_token_key
  on public.push_tokens (token);

create index if not exists products_active_category_idx
  on public.products (category_id, id)
  where is_active is true;

create index if not exists product_images_product_position_idx
  on public.product_images (product_id, position, id);

create index if not exists order_items_order_id_idx
  on public.order_items (order_id);

create index if not exists order_items_product_id_idx
  on public.order_items (product_id)
  where product_id is not null;

create index if not exists orders_created_at_idx
  on public.orders (created_at desc);

create index if not exists subscribers_subscribed_at_idx
  on public.subscribers (subscribed_at desc);

create index if not exists notify_me_created_at_idx
  on public.notify_me (created_at desc);

create index if not exists episodes_episode_number_idx
  on public.episodes (episode_number);

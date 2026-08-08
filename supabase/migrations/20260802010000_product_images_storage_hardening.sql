-- Secure product-image administration. Database rows are mutated only through
-- service-role RPCs called by the authenticated Express API. Storage object
-- policies are narrowed without changing bucket metadata or stored objects.

create or replace function public.insert_product_image_admin(
  p_product_id uuid,
  p_url text,
  p_storage_path text
)
returns public.product_images
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products%rowtype;
  v_position integer;
  v_image public.product_images%rowtype;
  v_has_display_order boolean;
begin
  select *
    into v_product
    from public.products
   where id = p_product_id
   for update;

  if not found then
    raise exception using message = 'product_not_found';
  end if;
  if v_product.is_active is distinct from true then
    raise exception using message = 'product_inactive';
  end if;
  if nullif(btrim(p_url), '') is null then
    raise exception using message = 'product_image_url_invalid';
  end if;
  if p_storage_path is null
     or p_storage_path !~ (
       '^' || p_product_id::text ||
       '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
     ) then
    raise exception using message = 'product_image_storage_path_unsafe';
  end if;

  select coalesce(max(position), -1) + 1
    into v_position
    from public.product_images
   where product_id = p_product_id;

  select exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'product_images'
       and column_name = 'display_order'
  ) into v_has_display_order;

  if v_has_display_order then
    execute $insert$
      insert into public.product_images (
        product_id, url, position, storage_path, display_order
      ) values ($1, $2, $3, $4, $3)
      returning *
    $insert$
    into v_image
    using p_product_id, p_url, v_position, p_storage_path;
  else
    insert into public.product_images (product_id, url, position, storage_path)
    values (p_product_id, p_url, v_position, p_storage_path)
    returning * into v_image;
  end if;

  return v_image;
end;
$$;

create or replace function public.delete_product_image_admin(
  p_image_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_image public.product_images%rowtype;
begin
  select *
    into v_image
    from public.product_images
   where id = p_image_id
   for update;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  if not exists (
    select 1 from public.products where id = v_image.product_id
  ) then
    raise exception using message = 'product_image_relationship_invalid';
  end if;
  if v_image.storage_path is null then
    raise exception using message = 'product_image_storage_path_missing';
  end if;
  if v_image.storage_path !~ (
    '^' || v_image.product_id::text ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  ) then
    raise exception using message = 'product_image_storage_path_unsafe';
  end if;

  delete from public.product_images where id = v_image.id;

  return jsonb_build_object(
    'found', true,
    'image_id', v_image.id,
    'product_id', v_image.product_id,
    'storage_path', v_image.storage_path
  );
end;
$$;

create or replace function public.reorder_product_images_admin(
  p_product_id uuid,
  p_image_ids uuid[]
)
returns setof public.product_images
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expected integer;
  v_actual integer;
  v_has_display_order boolean;
begin
  if p_image_ids is null or cardinality(p_image_ids) > 100 then
    raise exception using message = 'invalid_product_image_order';
  end if;
  if exists (
    select 1
      from unnest(p_image_ids) as requested(image_id)
     group by requested.image_id
    having count(*) > 1
  ) then
    raise exception using message = 'duplicate_product_image_id';
  end if;

  perform 1
    from public.products
   where id = p_product_id
   for update;
  if not found then
    raise exception using message = 'product_not_found';
  end if;

  perform 1
    from public.product_images
   where product_id = p_product_id
   order by id
   for update;

  v_expected := cardinality(p_image_ids);
  select count(*)::integer
    into v_actual
    from public.product_images
   where product_id = p_product_id;

  if v_actual <> v_expected
     or exists (
       select 1
         from unnest(p_image_ids) as requested(image_id)
        where not exists (
          select 1
            from public.product_images as image
           where image.id = requested.image_id
             and image.product_id = p_product_id
        )
     ) then
    raise exception using message = 'product_image_set_mismatch';
  end if;

  update public.product_images as image
     set position = (requested.ordinality - 1)::integer
    from unnest(p_image_ids) with ordinality as requested(image_id, ordinality)
   where image.id = requested.image_id
     and image.product_id = p_product_id;

  select exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'product_images'
       and column_name = 'display_order'
  ) into v_has_display_order;

  if v_has_display_order then
    execute $reorder$
      update public.product_images as image
         set display_order = (requested.ordinality - 1)::integer
        from unnest($1) with ordinality as requested(image_id, ordinality)
       where image.id = requested.image_id
         and image.product_id = $2
    $reorder$
    using p_image_ids, p_product_id;
  end if;

  return query
    select image.*
      from public.product_images as image
     where image.product_id = p_product_id
     order by image.position, image.id;
end;
$$;

create or replace function public.delete_product_admin(
  p_product_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_image_count integer;
  v_path_count integer;
  v_storage_paths text[];
begin
  perform 1
    from public.products
   where id = p_product_id
   for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  perform 1
    from public.product_images
   where product_id = p_product_id
   order by id
   for update;

  select count(*)::integer,
         count(storage_path)::integer,
         coalesce(array_agg(storage_path order by id), array[]::text[])
    into v_image_count, v_path_count, v_storage_paths
    from public.product_images
   where product_id = p_product_id;

  if v_path_count <> v_image_count then
    raise exception using message = 'product_image_storage_path_missing';
  end if;
  if exists (
    select 1
      from unnest(v_storage_paths) as stored(image_path)
     where stored.image_path !~ (
       '^' || p_product_id::text ||
       '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
     )
  ) then
    raise exception using message = 'product_image_storage_path_unsafe';
  end if;

  -- Existing BEFORE DELETE protection raises product_has_unsettled_order.
  -- Because this function is one transaction, that exception also preserves
  -- every product_images row and the product row.
  delete from public.products where id = p_product_id;

  return jsonb_build_object(
    'found', true,
    'product_id', p_product_id,
    'image_count', v_image_count,
    'storage_paths', to_jsonb(v_storage_paths)
  );
end;
$$;

revoke all on function public.insert_product_image_admin(uuid, text, text) from public, anon, authenticated;
revoke all on function public.delete_product_image_admin(uuid) from public, anon, authenticated;
revoke all on function public.reorder_product_images_admin(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.delete_product_admin(uuid) from public, anon, authenticated;

grant execute on function public.insert_product_image_admin(uuid, text, text) to service_role;
grant execute on function public.delete_product_image_admin(uuid) to service_role;
grant execute on function public.reorder_product_images_admin(uuid, uuid[]) to service_role;
grant execute on function public.delete_product_admin(uuid) to service_role;

-- Preserve public product-image reads even when an old broad ALL policy must
-- be narrowed below. This policy grants SELECT only and cannot authorize any
-- object mutation.
drop policy if exists product_images_storage_public_read on storage.objects;
create policy product_images_storage_public_read
  on storage.objects
  for select
  to public
  using (bucket_id = 'product-images');

-- Inspect actual catalog definitions instead of relying on legacy names.
-- An unsafe permissive mutation policy is either:
--   * explicitly able to target product-images; or
--   * broad/unscoped, in which case adding a bucket exclusion preserves its
--     behavior for every other bucket.
-- A conjunctive bucket_id equality to a different bucket is provably scoped
-- elsewhere and is left byte-for-byte unchanged.
do $harden_product_image_policies$
declare
  v_policy record;
  v_qual text;
  v_check text;
  v_scope text;
  v_scoped_other_bucket boolean;
begin
  for v_policy in
    select p.oid,
           p.polname,
           p.polcmd,
           p.polrelid,
           pg_get_expr(p.polqual, p.polrelid) as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as with_check
      from pg_policy as p
      join pg_class as c on c.oid = p.polrelid
      join pg_namespace as n on n.oid = c.relnamespace
     where n.nspname = 'storage'
       and c.relname = 'objects'
       and p.polpermissive
       and p.polcmd in ('a', 'w', 'd', '*')
       and (
         0::oid = any(p.polroles)
         or to_regrole('anon')::oid = any(p.polroles)
         or to_regrole('authenticated')::oid = any(p.polroles)
       )
  loop
    v_qual := coalesce(v_policy.qual, 'true');
    v_check := coalesce(v_policy.with_check, 'true');
    v_scope := coalesce(v_policy.qual, '') || ' ' || coalesce(v_policy.with_check, '');
    v_scoped_other_bucket :=
      v_scope !~* 'product-images'
      and v_scope !~* '(^|[^[:alpha:]])or([^[:alpha:]]|$)'
      and v_scope ~* 'bucket_id[[:space:]]*=[[:space:]]*''[^'']+''(::text)?';

    if v_scoped_other_bucket then
      continue;
    end if;

    -- Never rewrite an InstaPay-specific definition. If its expression is
    -- unexpectedly broad, abort for manual inspection instead of guessing.
    if v_scope ~* 'instapay-proofs'
       and v_scope !~* 'product-images' then
      raise exception using message = format(
        'product_images_storage_policy_scope_ambiguous: policy %s mentions instapay-proofs but is not provably bucket-scoped',
        v_policy.polname
      );
    end if;

    if v_policy.polcmd = 'a' then
      execute format(
        'alter policy %I on storage.objects with check ((%s) and bucket_id is distinct from %L)',
        v_policy.polname,
        v_check,
        'product-images'
      );
    elsif v_policy.polcmd = 'd' then
      execute format(
        'alter policy %I on storage.objects using ((%s) and bucket_id is distinct from %L)',
        v_policy.polname,
        v_qual,
        'product-images'
      );
    else
      execute format(
        'alter policy %I on storage.objects using ((%s) and bucket_id is distinct from %L) with check ((%s) and bucket_id is distinct from %L)',
        v_policy.polname,
        v_qual,
        'product-images',
        v_check,
        'product-images'
      );
    end if;
  end loop;
end
$harden_product_image_policies$;

-- Fail closed if any unsafe mutation policy could not be categorized or
-- narrowed. This assertion changes no data.
do $verify_product_image_policies$
declare
  v_policy record;
  v_scope text;
  v_scoped_other_bucket boolean;
begin
  for v_policy in
    select p.polname,
           p.polcmd,
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') as qual,
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as with_check
      from pg_policy as p
      join pg_class as c on c.oid = p.polrelid
      join pg_namespace as n on n.oid = c.relnamespace
     where n.nspname = 'storage'
       and c.relname = 'objects'
       and p.polpermissive
       and p.polcmd in ('a', 'w', 'd', '*')
       and (
         0::oid = any(p.polroles)
         or to_regrole('anon')::oid = any(p.polroles)
         or to_regrole('authenticated')::oid = any(p.polroles)
       )
  loop
    v_scope := v_policy.qual || ' ' || v_policy.with_check;
    v_scoped_other_bucket :=
      v_scope !~* 'product-images'
      and v_scope !~* '(^|[^[:alpha:]])or([^[:alpha:]]|$)'
      and v_scope ~* 'bucket_id[[:space:]]*=[[:space:]]*''[^'']+''(::text)?';

    if not v_scoped_other_bucket
       and v_scope !~* 'bucket_id is distinct from ''product-images''' then
      raise exception using message = format(
        'product_images_storage_policy_hardening_failed: policy %s remains unsafe',
        v_policy.polname
      );
    end if;
  end loop;
end
$verify_product_image_policies$;

-- READ-ONLY verification for 20260802010000_product_images_storage_hardening.
-- Expected: every boolean contract below is true and unsafe_policy_count is 0.

select
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types,
  public is true as public_read_metadata_preserved
from storage.buckets
where id = 'product-images';

select
  count(*) filter (
    where policyname = 'product_images_storage_public_read'
      and cmd = 'SELECT'
      and roles @> array['public']::name[]
      and qual ~ 'product-images'
  ) = 1 as explicit_public_select_policy_present
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects';

with admin_functions(signature) as (
  values
    ('public.insert_product_image_admin(uuid,text,text)'),
    ('public.delete_product_image_admin(uuid)'),
    ('public.reorder_product_images_admin(uuid,uuid[])'),
    ('public.delete_product_admin(uuid)')
)
select
  signature,
  to_regprocedure(signature) is not null as function_exists,
  has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE')
    as service_role_can_execute,
  not has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE')
    as anon_cannot_execute,
  not has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE')
    as authenticated_cannot_execute
from admin_functions
order by signature;

-- Catalog evidence for all public/anon/authenticated mutation policies.
select
  policyname,
  cmd,
  roles,
  qual,
  with_check
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and permissive = 'PERMISSIVE'
  and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  and roles && array['public', 'anon', 'authenticated']::name[]
order by policyname;

-- A row here is a blocker. Policies proven to be a conjunctive equality for
-- a different bucket are unrelated; every broad/product policy must carry the
-- explicit product-images exclusion added by the migration.
with mutation_policies as (
  select
    policyname,
    cmd,
    coalesce(qual, '') || ' ' || coalesce(with_check, '') as scope
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and permissive = 'PERMISSIVE'
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    and roles && array['public', 'anon', 'authenticated']::name[]
), categorized as (
  select *,
    scope !~* 'product-images'
      and scope !~* '(^|[^[:alpha:]])or([^[:alpha:]]|$)'
      and scope ~* 'bucket_id[[:space:]]*=[[:space:]]*''[^'']+''(::text)?'
      as scoped_other_bucket,
    scope ~* 'bucket_id is distinct from ''product-images'''
      as product_images_excluded
  from mutation_policies
)
select
  count(*) as unsafe_policy_count,
  coalesce(array_agg(policyname order by policyname), array[]::name[])
    as unsafe_policies
from categorized
where not scoped_other_bucket
  and not product_images_excluded;

-- Snapshot only: compare this output with the prior read-only preflight.
-- The hardening migration does not target these definitions.
select
  policyname,
  cmd,
  roles,
  qual,
  with_check
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and (
    coalesce(qual, '') ~ 'instapay-proofs'
    or coalesce(with_check, '') ~ 'instapay-proofs'
  )
order by policyname;

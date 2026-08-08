-- Reproducible Storage bucket contracts. This migration changes bucket
-- metadata only; it does not delete, move, read or rewrite existing objects.

-- Private payment proofs: service-role upload/read and short-lived signed URLs
-- remain the only application access path.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'instapay-proofs',
  'instapay-proofs',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Product image evidence: the admin UI accepts JPEG/PNG/WebP and rejects input
-- above 5 MiB before compressing it. Public object reads are required because
-- the catalog stores getPublicUrl() URLs. No anonymous upload/update/delete
-- policy is created here; that broken browser mutation path remains disabled
-- until a later JWT-protected backend image task is implemented.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'product-images',
  'product-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

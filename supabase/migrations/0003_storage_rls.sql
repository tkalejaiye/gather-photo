-- Guest resumable-upload auth for the private `event-media` bucket (FRI-14).
--
-- FRI-11's direct upload used `createSignedUploadUrl` — one signed URL per
-- object per attempt. Supabase's TUS/resumable endpoint (which FRI-13's
-- uploader hits) does not accept signed-URL tokens as Authorization: it
-- authenticates with a standard Supabase JWT and gates writes with RLS on
-- `storage.objects`. So for the resumable path to work at all, we need RLS
-- policies that let the anon role INSERT/UPDATE/SELECT its own object rows —
-- but scoped tightly to (a) our bucket, (b) the `events/{event_id}/...`
-- path shape, (c) events that are still active + unexpired, (d) image
-- mimetypes (photos-first, TECH_SPEC §1).
--
-- Constraint on the path is important: RLS is what stops a hostile anon
-- client from writing arbitrary keys into the bucket (path traversal,
-- squatting other events, etc). The register route (§9) is the *second*
-- gate — it re-verifies the event is open + the object actually landed —
-- so a client that races the "event closed" boundary during an upload
-- has its media row rejected, and its orphan blob is cleaned up by the
-- `storage_expires_at` sweep.
--
-- The event-open check has to happen inside RLS, which runs as the anon
-- role. `security definer` lets the helper read `public.events` (RLS on
-- events blocks anon) without exposing any row data — it only returns a
-- boolean.

create or replace function public.event_open_by_id(event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.events e
    where e.id = event_id
      and e.status = 'active'
      and (e.uploads_close_at is null or e.uploads_close_at > now())
      and (e.storage_expires_at is null or e.storage_expires_at > now())
  );
$$;

revoke all on function public.event_open_by_id(uuid) from public;
grant execute on function public.event_open_by_id(uuid) to anon, authenticated;

-- RLS policies on storage.objects for the `event-media` bucket.
-- `storage.foldername(name)` splits the object name by '/', so for a key
-- like `events/{event_id}/{uuid}.jpg` the segments are:
--   [1] = 'events'
--   [2] = '{event_id}'
--   [3] = '{uuid}.jpg'
-- We require both the literal 'events' prefix and a valid, open event id.
-- The UUID regex is a defensive guard: `::uuid` on a non-UUID string raises
-- `invalid_text_representation` which bubbles up as a 500 to the guest;
-- reject shape-invalid paths as a plain policy miss (403) instead.
--
-- INSERT covers the final row commit. UPDATE covers the chunk-by-chunk
-- multipart writes that Supabase's TUS handler performs on the same row
-- when resuming from `x-upsert: true`. SELECT covers the HEAD/GET probe
-- tus-js-client fires on resume to discover the last committed offset —
-- without it the resume path silently degrades to "start over".
--
-- The mimetype gate keeps this route photos-first (TECH_SPEC §1) — it
-- replaces the ALLOWED_CONTENT_TYPES check the retired /api/uploads/sign
-- used to enforce. `metadata->>'mimetype'` is what Supabase Storage
-- populates from the TUS metadata's `contentType` field; if it's absent
-- (older client), we fall back to the file extension in the path.
--
-- Drop-then-create keeps the migration idempotent when re-run against a
-- staging DB.

drop policy if exists "anon insert event-media" on storage.objects;
create policy "anon insert event-media" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'event-media'
    and (storage.foldername(name))[1] = 'events'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.event_open_by_id(((storage.foldername(name))[2])::uuid)
    and (
      coalesce(metadata->>'mimetype', '') like 'image/%'
      or lower(storage.extension(name)) in ('jpg','jpeg','png','webp','heic','heif','gif')
    )
  );

drop policy if exists "anon update event-media" on storage.objects;
create policy "anon update event-media" on storage.objects
  for update to anon
  using (
    bucket_id = 'event-media'
    and (storage.foldername(name))[1] = 'events'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.event_open_by_id(((storage.foldername(name))[2])::uuid)
  )
  with check (
    bucket_id = 'event-media'
    and (storage.foldername(name))[1] = 'events'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.event_open_by_id(((storage.foldername(name))[2])::uuid)
    and (
      coalesce(metadata->>'mimetype', '') like 'image/%'
      or lower(storage.extension(name)) in ('jpg','jpeg','png','webp','heic','heif','gif')
    )
  );

-- SELECT is needed for the resume HEAD probe. Scoped to the SAME event-open
-- window so a closed event is unreadable via anon just like it's unwritable.
-- Reads for the host gallery still go through short-lived signed URLs from
-- the service role, so this policy doesn't widen the guest read surface.
drop policy if exists "anon select event-media" on storage.objects;
create policy "anon select event-media" on storage.objects
  for select to anon
  using (
    bucket_id = 'event-media'
    and (storage.foldername(name))[1] = 'events'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.event_open_by_id(((storage.foldername(name))[2])::uuid)
  );

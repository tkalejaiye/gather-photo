-- Close the anon SELECT window on storage.objects (FRI-44).
--
-- The hole. 0003_storage_rls.sql granted `anon` SELECT on every object under
-- `events/{event_id}/…` for as long as the event is open. That policy exists
-- for one reason: tus-js-client's resume path HEAD-probes the object to
-- discover the last committed byte offset. But a guest necessarily knows
-- `event_id` (it's in the upload path), so with the public anon key the same
-- policy also permits `.list('events/{event_id}/')` and `.download()` of ANY
-- object in the event — including media the host has left `pending` or
-- explicitly `rejected`. `media.status` gates the signed-URL read paths only;
-- the storage layer knew nothing about approval, so FRI-30's moderation model
-- was bypassable at the storage layer.
--
-- Measured on production before this migration: the anon role could read 62
-- objects across open events, 36 of them in a single event.
--
-- The fix. Keep anon SELECT for exactly the window tus needs and no longer.
-- An upload is registered by /api/uploads/register only AFTER the bytes have
-- finished landing, so for the entire life of a transfer — including every
-- resume and every reconnect — no `media` row points at the object yet. That
-- gives us a precise predicate: anon may read an object only while it is
-- unregistered. The moment the row is inserted (pending, approved, or later
-- rejected) the object leaves anon's view permanently.
--
-- What this closes: no pending, approved, or rejected photo is readable or
-- listable with the anon key. A `.list()` now returns only objects still
-- mid-transfer — no completed photo, and nothing that has ever been through
-- moderation.
--
-- Why not simply drop anon SELECT altogether (option 3 on the ticket): that
-- would also remove it during the transfer, and whether Supabase's TUS handler
-- can serve `Upload-Offset` without a row-level SELECT is a property of the
-- storage service, not of this schema. Keeping the in-flight window makes the
-- change safe by construction — the resume probe sees exactly what it saw
-- before — while still closing the moderation bypass completely.
--
-- Unaffected: every server-side read (host gallery grid, ZIP download, the
-- register route's existence check) goes through the service-role client and
-- bypasses RLS entirely. INSERT and UPDATE policies are untouched, so uploads
-- and chunk PATCHes behave exactly as before.

-- `security definer` for the same reason as event_open_by_id: the policy runs
-- as anon, which RLS on public.media blocks. The function returns only a
-- boolean and never leaks row data.
create or replace function public.storage_object_unregistered(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.media m where m.storage_path = object_name
  );
$$;

comment on function public.storage_object_unregistered(text) is
  'True while no media row points at this storage object — i.e. the upload is still in flight. Used by the anon SELECT policy on storage.objects so the TUS resume probe keeps working without exposing registered (pending/approved/rejected) media. FRI-44.';

revoke all on function public.storage_object_unregistered(text) from public;
grant execute on function public.storage_object_unregistered(text) to anon, authenticated;

-- The policy calls the helper once per candidate row on every `.list()`, so
-- the lookup must not be a sequential scan over the whole media table.
create index if not exists media_storage_path_idx on public.media (storage_path);

drop policy if exists "anon select event-media" on storage.objects;
drop policy if exists "anon select event-media in flight" on storage.objects;
create policy "anon select event-media in flight" on storage.objects
  for select to anon
  using (
    bucket_id = 'event-media'
    and (storage.foldername(name))[1] = 'events'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.event_open_by_id(((storage.foldername(name))[2])::uuid)
    and public.storage_object_unregistered(name)
  );

-- Rollback (restores the 0003 behaviour, hole included):
--   drop policy if exists "anon select event-media in flight" on storage.objects;
--   create policy "anon select event-media" on storage.objects
--     for select to anon
--     using (
--       bucket_id = 'event-media'
--       and (storage.foldername(name))[1] = 'events'
--       and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
--       and public.event_open_by_id(((storage.foldername(name))[2])::uuid)
--     );

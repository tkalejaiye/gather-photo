-- Photo approval (FRI-30). Guest uploads must not reach the shared/guest
-- gallery until the host approves them; until then a photo is visible only
-- to its uploader and the host.
--
-- media.status vocabulary changes from 'active'|'deleted' to:
--   'pending'  — registered, awaiting host review. Hidden from anything
--                public (guest counts, the FRI-37 guest gallery, default
--                ZIP). Visible to the host (moderation queue) and — once a
--                guest read path exists — to its own uploader by
--                uploader_token.
--   'approved' — host approved (or auto-approved). The only status that any
--                public/guest-facing read may serve.
--   'rejected' — host removed it (the FRI-17 soft-delete, renamed: "reject
--                a pending photo" and "delete an approved photo" are the
--                same transition). Invisible everywhere except the eventual
--                hard-delete sweep; storage objects are reclaimed by the
--                storage_expires_at cleanup.
--
-- Existing rows are grandfathered: 'active' → 'approved' (they were already
-- host-curated and there is no moderation backlog to force onto hosts),
-- 'deleted' → 'rejected' (same meaning, new name).

alter table events
  add column if not exists auto_approve boolean not null default false;
comment on column events.auto_approve is
  'When true, /api/uploads/register inserts media as approved instead of pending. Default false per FRI-30: approval is required unless the host opts out of moderating.';

update media set status = 'approved' where status = 'active';
update media set status = 'rejected' where status = 'deleted';

-- New uploads await approval unless the register route explicitly says
-- otherwise (it always sets status now; the default is a safety net for any
-- future insert path that forgets).
alter table media alter column status set default 'pending';

-- Guard the vocabulary. Text + CHECK (not an enum) so a future status can
-- land with a plain constraint swap instead of an enum migration.
-- NOT VALID + VALIDATE splits "enforce for new writes" (metadata-only, no
-- long ACCESS EXCLUSIVE full-table scan) from the row validation, which
-- runs with a weaker lock — matters if this ever re-runs on a large table.
alter table media drop constraint if exists media_status_check;
alter table media
  add constraint media_status_check
  check (status in ('pending', 'approved', 'rejected'))
  not valid;
alter table media validate constraint media_status_check;

-- Uploader pills on the host dashboard count everything the host can see:
-- pending + approved. Rejected rows stay out (matches the pre-FRI-30
-- behavior where deleted rows vanished from the pills).
create or replace function public.event_uploader_counts(p_event_id uuid)
returns table (
  uploader_token text,
  display_name text,
  media_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(uploader_token, '') as uploader_token,
    min(uploader_name) as display_name,
    count(*)::bigint as media_count
  from public.media
  where event_id = p_event_id
    and status in ('pending', 'approved')
  group by coalesce(uploader_token, '')
  order by count(*) desc, min(uploader_name) asc nulls last;
$$;

revoke all on function public.event_uploader_counts(uuid) from public;
grant execute on function public.event_uploader_counts(uuid) to authenticated, service_role;

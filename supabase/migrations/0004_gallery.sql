-- Host gallery grid (FRI-16). Supports:
--   1. Paginated fetch of active media for an event, newest-first.
--   2. Grouped uploader counts (total + per-uploader) driving the filter UI.
--
-- The base `media_event_status_idx` (event_id, status) from 0001_init.sql lets
-- Postgres locate the event's rows quickly, but a 1,000-photo event still
-- forces a sort every page load without a covering index. This adds one that
-- serves the newest-first pagination directly.
create index if not exists media_event_created_idx
  on public.media (event_id, status, created_at desc, id desc);

-- Grouped counts by uploader_token. Called by the gallery server component to
-- render "Total N · <name> · <name> · anonymous" with per-uploader totals.
-- Doing the group-by in the DB avoids fetching every media row into Node just
-- to bucket by token.
--
-- `security invoker` deliberately: the host's authenticated Supabase client
-- calls this, and RLS on `public.media` scopes rows to events they own. A
-- `security definer` variant would need explicit event-ownership checks
-- inside the function; invoker inherits the same guarantees RLS already
-- provides on plain SELECTs.
--
-- Name pick: `min(uploader_name)` when a guest changed their display name
-- mid-event. Deterministic and cheap; the pathological case (real name
-- collision) is fine because the token is what the filter keys on.
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
    and status = 'active'
  group by coalesce(uploader_token, '')
  order by count(*) desc, min(uploader_name) asc nulls last;
$$;

revoke all on function public.event_uploader_counts(uuid) from public;
grant execute on function public.event_uploader_counts(uuid) to authenticated, service_role;

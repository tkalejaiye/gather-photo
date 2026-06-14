-- gather.photo initial schema
-- Hosts are Supabase auth users; profiles holds extra fields.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  role text not null default 'host',          -- 'host' | 'vendor'
  created_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  slug text unique not null,                  -- short, unguessable; used in guest URL
  pin text,                                   -- optional extra gate for guests
  event_date date,
  cover_media_id uuid,
  tier text not null default 'pending',       -- 'pending'|'lite'|'standard'|'premium'
  guest_upload_cap int,                       -- per-guest photo cap (null = unlimited)
  status text not null default 'draft',       -- 'draft'|'active'|'expired'
  paid boolean not null default false,
  uploads_close_at timestamptz,
  storage_expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  uploader_token text,                        -- anonymous guest id (localStorage)
  uploader_name text,
  storage_path text not null,
  kind text not null default 'photo',         -- 'photo' | 'video'
  bytes bigint,
  width int,
  height int,
  content_hash text,                          -- dedupe per event
  captured_at timestamptz,                    -- from EXIF when available
  status text not null default 'active',      -- 'active' | 'deleted'
  created_at timestamptz not null default now()
);
create index if not exists media_event_status_idx on media (event_id, status);
create unique index if not exists media_event_hash_uniq on media (event_id, content_hash);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  paystack_ref text unique not null,
  amount_kobo bigint not null,                -- naira * 100
  channel text,                               -- 'card'|'bank_transfer'|'ussd'...
  status text not null default 'pending',     -- 'pending'|'success'|'failed'
  created_at timestamptz not null default now()
);

-- Row Level Security ---------------------------------------------------------
alter table profiles enable row level security;
alter table events   enable row level security;
alter table media    enable row level security;
alter table payments enable row level security;

-- Hosts manage their own profile
create policy "own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- Hosts manage their own events
create policy "own events" on events
  for all using (auth.uid() = host_id) with check (auth.uid() = host_id);

-- Hosts read/manage media under their events
create policy "own media" on media
  for all using (
    exists (select 1 from events e where e.id = media.event_id and e.host_id = auth.uid())
  );

-- Hosts read payments for their events
create policy "own payments" on payments
  for select using (
    exists (select 1 from events e where e.id = payments.event_id and e.host_id = auth.uid())
  );

-- Privileges -----------------------------------------------------------------
-- Supabase usually applies these automatically; set explicitly so the schema is
-- reproducible. RLS (above) still gates row-level access. `anon` is intentionally
-- granted nothing: guests never query the DB directly (writes go via a server
-- route using the service role).
grant usage on schema public to authenticated, service_role;

grant all on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;

alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- NOTE: anonymous guest uploads are NOT handled by client-side RLS.
-- Guests write via a server route (service role) or a scoped Storage policy
-- that validates an active, unexpired event slug. See TECH_SPEC.md §9.

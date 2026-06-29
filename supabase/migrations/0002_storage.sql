-- Storage bucket for guest uploads.
--
-- Private bucket — reads happen via short-lived signed URLs handed out by the
-- host gallery (TECH_SPEC §9). Writes go through `createSignedUploadUrl`
-- issued by a server route after validating an active, unexpired event.
-- `anon` never touches the bucket directly.
--
-- file_size_limit caps a single compressed photo. The guest pipeline targets
-- ~2048px / ~0.8 quality JPEG which is well under a megabyte; 30 MB leaves
-- room for unusual originals + the future video lane (PRD §8, ≤100 MB cap is
-- per-file but defers to bucket policy in MVP).
insert into storage.buckets (id, name, public, file_size_limit)
values ('event-media', 'event-media', false, 30 * 1024 * 1024)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

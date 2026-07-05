// Seed a large event for FRI-16 host-gallery verification.
//
// Usage:
//   npm run seed:gallery -- --host <host-user-id> [--count 1000] [--uploaders 5]
//   (or) node --env-file=.env.local scripts/seed-gallery.mjs --host <uid>
//
// What it does:
//   1. Uploads a small placeholder PNG (~120 bytes) to
//      `events/{event_id}/{uuid}.png` for each of `count` media rows.
//   2. Inserts a matching `media` row so the gallery grid renders it.
//   3. Attributes rows round-robin across `uploaders` guest tokens, with one
//      bucket left as NULL (anonymous) so the "Anonymous" filter is populated.
//
// The generated event is:
//   - unpaid (tier=pending, status=active) — enough to render in the dashboard
//     while remaining obviously non-production.
//   - marked with a unique slug + name so multiple runs don't collide.
//
// The upload uses the service role and bypasses the compression/TUS pipeline
// — the goal is a plausible 1,000-row shape, not a load test of the ingest
// path. If you want to load-test uploads, use the guest flow at /e/{slug}.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]);
}

const hostId = args.get("host");
if (!hostId) {
  console.error("--host <user-id> is required. Use the auth.users.id of an existing host.");
  process.exit(1);
}
const count = Number(args.get("count") ?? "1000");
const uploaderCount = Number(args.get("uploaders") ?? "5");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// Ensure the host has a profile row — the events FK points at profiles.id.
{
  const { error } = await supabase
    .from("profiles")
    .upsert({ id: hostId }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`profiles upsert failed: ${error.message}`);
}

const slug = `seed-${randomUUID().slice(0, 8)}`;
const eventName = `Seeded Gallery (${new Date().toISOString().slice(0, 10)})`;
console.log(`Creating event "${eventName}" slug=${slug}…`);
const { data: event, error: eventErr } = await supabase
  .from("events")
  .insert({
    host_id: hostId,
    name: eventName,
    slug,
    tier: "pending",
    status: "active",
    uploads_close_at: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
    storage_expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
  })
  .select("id")
  .single();
if (eventErr || !event) throw new Error(`event insert failed: ${eventErr?.message}`);

// One anonymous bucket + N named guests. Deterministic names so re-runs are
// easy to reason about.
const uploaders = [{ token: null, name: null }];
for (let i = 1; i <= uploaderCount; i += 1) {
  uploaders.push({ token: `seed-guest-${i}`, name: `Guest ${i}` });
}

// A tiny PNG (1×1, 8-bit, opaque black). Enough bytes to satisfy the object
// existence check in /api/uploads/register on real uploads, and cheap enough
// to write 1,000 of.
const TINY_PNG = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489" +
    "0000000A49444154789C6360000000000200015E7FE7B10000000049454E44AE426082",
  "hex",
);

console.log(`Uploading ${count} placeholder objects + rows…`);
let uploaded = 0;
let failed = 0;
for (let i = 0; i < count; i += 1) {
  const objectId = randomUUID();
  const path = `events/${event.id}/${objectId}.png`;
  const { error: upErr } = await supabase.storage
    .from("event-media")
    .upload(path, TINY_PNG, { contentType: "image/png", upsert: false });
  if (upErr) {
    failed += 1;
    if (failed < 5) console.error(`  upload failed: ${upErr.message}`);
    continue;
  }
  const uploader = uploaders[i % uploaders.length];
  const { error: rowErr } = await supabase.from("media").insert({
    event_id: event.id,
    uploader_token: uploader.token,
    uploader_name: uploader.name,
    storage_path: path,
    kind: "photo",
    bytes: TINY_PNG.length,
    width: 1,
    height: 1,
    content_hash: `seed-${event.id}-${i}`,
  });
  if (rowErr) {
    failed += 1;
    if (failed < 5) console.error(`  row insert failed: ${rowErr.message}`);
    continue;
  }
  uploaded += 1;
  if (uploaded % 100 === 0) process.stdout.write(`  ${uploaded}/${count}\n`);
}

console.log(`\nDone. event.id=${event.id} slug=${slug} inserted=${uploaded} failed=${failed}`);
console.log(`Open http://localhost:3000/dashboard/events/${event.id} to view.`);

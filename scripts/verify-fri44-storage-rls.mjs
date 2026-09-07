// FRI-44 storage-RLS verification.
//
// Usage:
//   npm run verify:fri44
//
// What it does:
//   1. Creates a throwaway host (+ profile, so the events.host_id FK holds)
//      and one active event.
//   2. RESUME STILL WORKS: with the public anon key only, starts a real
//      resumable (TUS) upload of a two-chunk payload, aborts it after the
//      first 6MB chunk commits, then starts a second Upload against the same
//      upload URL. tus-js-client HEAD-probes for the offset and continues —
//      this is the exact path the 0003 anon SELECT policy existed to serve,
//      and the reason 0006 keeps SELECT open while an object is unregistered.
//   3. HOLE IS CLOSED: registers the object the way /api/uploads/register
//      does (a `pending` media row), then proves with the anon key that
//      `.list('events/<id>/')` no longer returns it and `.download()` of the
//      known exact path is refused. Both of these SUCCEED before 0006 — that
//      is the moderation bypass the migration closes.
//   4. HOST PATH UNAFFECTED: the service-role client can still sign a URL for
//      the same object (this is how the gallery and the ZIP download read).
//   5. Cleans up the object, media row, event, and user regardless of outcome.
//
// This is the automated half of the FRI-44 acceptance criteria. The other
// half — a mid-upload network drop and resume on a real iOS Safari and a
// low-end Android over a throttled connection (TECH_SPEC §8) — still has to
// be run by hand as part of FRI-23.
//
// Requires .env.local with the standard gather.photo Supabase keys plus
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import * as tus from "tus-js-client";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error(
    "Missing env — set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
  );
  process.exit(1);
}

const BUCKET = "event-media";
// Supabase's TUS endpoint requires a fixed 6MB chunk; the payload is sized to
// span two of them so there is a real committed offset to resume from.
const CHUNK_SIZE = 6 * 1024 * 1024;
const PAYLOAD_BYTES = CHUNK_SIZE + 512 * 1024;

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.error(`  ✗ ${m}`);
  process.exitCode = 1;
};

const created = { userId: null, eventId: null, mediaId: null, path: null };

async function cleanup() {
  console.log("\nCleaning up test data…");
  if (created.path) {
    await admin.storage.from(BUCKET).remove([created.path]).catch(() => {});
  }
  if (created.mediaId) {
    await admin.from("media").delete().eq("id", created.mediaId);
  }
  if (created.eventId) {
    await admin.from("events").delete().eq("id", created.eventId);
  }
  if (created.userId) {
    await admin.auth.admin.deleteUser(created.userId).catch(() => {});
  }
  ok("cleanup complete");
}

process.on("uncaughtException", async (e) => {
  console.error("Uncaught:", e);
  await cleanup();
  process.exit(1);
});

/**
 * Run one tus.Upload to completion, or abort it once `abortAfterChunk` chunks
 * have committed. Resolves with the upload URL either way so the caller can
 * resume against it.
 */
function runUpload({ body, path, uploadUrl, abortAfterChunk }) {
  return new Promise((resolve, reject) => {
    let chunks = 0;
    let seenUrl = uploadUrl ?? null;
    const upload = new tus.Upload(body, {
      endpoint: `${url}/storage/v1/upload/resumable`,
      uploadUrl,
      chunkSize: CHUNK_SIZE,
      retryDelays: [0, 1000, 3000],
      uploadSize: body.length,
      headers: {
        authorization: `Bearer ${anonKey}`,
        apikey: anonKey,
        "x-upsert": "true",
      },
      metadata: {
        bucketName: BUCKET,
        objectName: path,
        contentType: "image/jpeg",
      },
      onUploadUrlAvailable: () => {
        if (upload.url) seenUrl = upload.url;
      },
      onChunkComplete: () => {
        chunks += 1;
        if (abortAfterChunk && chunks >= abortAfterChunk) {
          upload.abort().then(() => resolve({ url: seenUrl, aborted: true }));
        }
      },
      onSuccess: () => resolve({ url: seenUrl, aborted: false }),
      onError: (err) => reject(err),
    });
    upload.start();
  });
}

try {
  console.log("\nFRI-44 — storage RLS: anon must not read registered media\n");

  // ── fixtures ────────────────────────────────────────────────────────────
  const email = `fri44-${randomUUID()}@example.com`;
  const { data: user, error: userErr } = await admin.auth.admin.createUser({
    email,
    password: randomUUID(),
    email_confirm: true,
  });
  if (userErr || !user?.user) throw new Error(`createUser failed: ${userErr?.message}`);
  created.userId = user.user.id;
  await admin.from("profiles").upsert({ id: user.user.id, full_name: "FRI-44 host" });

  const { data: event, error: eventErr } = await admin
    .from("events")
    .insert({
      host_id: user.user.id,
      name: "FRI-44 verification",
      slug: `fri44-${randomUUID().slice(0, 8)}`,
      tier: "pending",
      status: "active",
    })
    .select()
    .single();
  if (eventErr || !event) throw new Error(`event insert failed: ${eventErr?.message}`);
  created.eventId = event.id;
  created.path = `events/${event.id}/${randomUUID()}.jpg`;
  ok(`event ${event.id} created`);

  // ── 1. resumable upload + resume, anon key only ─────────────────────────
  console.log("\n1. Resume path (the reason anon SELECT exists)…\n");
  const body = Buffer.alloc(PAYLOAD_BYTES, 7);

  const first = await runUpload({ body, path: created.path, abortAfterChunk: 1 });
  if (!first.aborted) bad("upload finished before we could abort — payload too small to test resume");
  else ok(`aborted after the first ${CHUNK_SIZE / 1024 / 1024}MB chunk`);
  if (!first.url) throw new Error("no upload URL captured — cannot test resume");

  const resumed = await runUpload({ body, path: created.path, uploadUrl: first.url });
  if (resumed.aborted) bad("resume did not complete");
  else ok("resumed from the committed offset and completed");

  const { data: signedCheck, error: signedCheckErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(created.path, 60);
  if (signedCheckErr || !signedCheck) bad(`object missing after resume: ${signedCheckErr?.message}`);
  else ok("object exists in storage after the resumed upload");

  // ── 2. register it, then the anon key must go blind ─────────────────────
  console.log("\n2. Once registered, anon must not see it…\n");
  const { data: media, error: mediaErr } = await admin
    .from("media")
    .insert({
      event_id: event.id,
      uploader_token: "fri44-guest",
      uploader_name: "FRI-44 guest",
      storage_path: created.path,
      kind: "photo",
      bytes: PAYLOAD_BYTES,
      content_hash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      status: "pending",
    })
    .select()
    .single();
  if (mediaErr || !media) throw new Error(`media insert failed: ${mediaErr?.message}`);
  created.mediaId = media.id;
  ok("media row registered as 'pending'");

  const { data: listed, error: listErr } = await anon.storage
    .from(BUCKET)
    .list(`events/${event.id}`);
  if (listErr) {
    ok(`anon .list() refused outright (${listErr.message})`);
  } else if ((listed ?? []).length === 0) {
    ok("anon .list() returns nothing for the event");
  } else {
    bad(`anon .list() still returns ${listed.length} object(s) — the hole is open`);
  }

  const { data: dl, error: dlErr } = await anon.storage.from(BUCKET).download(created.path);
  if (dlErr || !dl) ok(`anon .download() of the exact path refused (${dlErr?.message ?? "no body"})`);
  else bad(`anon .download() returned ${dl.size} bytes of a pending photo — the hole is open`);

  // ── 3. host read path unaffected ────────────────────────────────────────
  console.log("\n3. Host path (service role) still works…\n");
  const { data: signed, error: signErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(created.path, 60);
  if (signErr || !signed?.signedUrl) bad(`service-role signing broke: ${signErr?.message}`);
  else ok("service role still signs a URL for the same object");
} finally {
  await cleanup();
}

if (process.exitCode) {
  console.log("\nFAILED — see errors above.\n");
} else {
  console.log("\nPASSED — resume works, registered media is invisible to anon, host reads unaffected.\n");
}

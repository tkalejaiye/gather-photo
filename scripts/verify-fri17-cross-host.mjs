// FRI-17 cross-host verification.
//
// Usage:
//   1) Start the dev server:      npm run dev
//   2) In another terminal, run:  npm run verify:fri17
//
// What it does:
//   1. Creates two throwaway hosts (host-A and host-B) via the Supabase
//      admin API. Both get profile rows so the `events.host_id` FK holds.
//   2. Creates one event owned by host-B and inserts a fake media row.
//   3. Signs in as host-A via the password grant, builds the @supabase/ssr
//      cookie shape, and POSTs to /api/events/<host-B-event>/media/delete.
//      Expects HTTP 404 (RLS / ownsEvent gate).
//   4. Signs in as host-B and repeats the same POST as a positive control.
//      Expects HTTP 200 with { deleted: [<the media id>] } and the row
//      status flipping to 'rejected' in the DB (FRI-30 renamed 'deleted').
//   5. Cleans up the users, event, and media rows regardless of outcome.
//
// This is the "manual" verification listed in the FRI-17 PR test plan,
// scripted so it's runnable. Requires .env.local with the standard
// gather.photo Supabase keys plus SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

if (!url || !anonKey || !serviceKey) {
  console.error(
    "Missing env — set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
  );
  process.exit(1);
}

// The @supabase/ssr cookie name is `sb-<projectRef>-auth-token`, where
// projectRef is the leftmost subdomain of the Supabase URL. Grabbing it
// from the URL avoids a second env var and keeps the script portable.
const projectRef = new URL(url).host.split(".")[0];
const AUTH_COOKIE_NAME = `sb-${projectRef}-auth-token`;

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.error(`  ✗ ${m}`);
  process.exitCode = 1;
};

// --- Preflight ---------------------------------------------------------------
console.log("\nFRI-17 cross-host delete verification\n");
console.log(`Dev server: ${appUrl}`);
try {
  const res = await fetch(`${appUrl}/`, { redirect: "manual" });
  ok(`dev server reachable (HTTP ${res.status})`);
} catch (e) {
  bad(`dev server not reachable at ${appUrl} — start it with \`npm run dev\` first (${e.message})`);
  process.exit(1);
}

// --- Test fixtures -----------------------------------------------------------
// Deterministic-ish but unique per run so accidental repeats don't collide.
const runId = randomUUID().slice(0, 8);
const password = randomUUID();
const hostAEmail = `fri17-a-${runId}@example.test`;
const hostBEmail = `fri17-b-${runId}@example.test`;

const created = { userIds: [], eventId: null, mediaId: null };

async function cleanup() {
  console.log("\nCleaning up test data…");
  if (created.mediaId) {
    await admin.from("media").delete().eq("id", created.mediaId);
  }
  if (created.eventId) {
    await admin.from("events").delete().eq("id", created.eventId);
  }
  for (const uid of created.userIds) {
    // Profiles cascade off auth.users; deleting the user cleans up.
    await admin.auth.admin.deleteUser(uid).catch(() => {});
  }
  ok("cleanup complete");
}

// If we crash after creating anything, still tidy up.
process.on("uncaughtException", async (e) => {
  console.error("Uncaught:", e);
  await cleanup();
  process.exit(1);
});

try {
  console.log("\nProvisioning two throwaway hosts…");
  const { data: aUser, error: aErr } = await admin.auth.admin.createUser({
    email: hostAEmail,
    password,
    email_confirm: true,
  });
  if (aErr || !aUser?.user) throw new Error(`createUser(A) failed: ${aErr?.message}`);
  created.userIds.push(aUser.user.id);
  ok(`host-A ${hostAEmail} · id=${aUser.user.id}`);

  const { data: bUser, error: bErr } = await admin.auth.admin.createUser({
    email: hostBEmail,
    password,
    email_confirm: true,
  });
  if (bErr || !bUser?.user) throw new Error(`createUser(B) failed: ${bErr?.message}`);
  created.userIds.push(bUser.user.id);
  ok(`host-B ${hostBEmail} · id=${bUser.user.id}`);

  // Profiles are the FK target for events.host_id.
  {
    const { error } = await admin.from("profiles").upsert(
      [
        { id: aUser.user.id },
        { id: bUser.user.id },
      ],
      { onConflict: "id" },
    );
    if (error) throw new Error(`profiles upsert failed: ${error.message}`);
    ok("profiles seeded for both hosts");
  }

  // host-B's event + one media row. The delete endpoint doesn't touch
  // storage, so we can point storage_path at a plausible-looking path
  // without uploading a real object.
  const slug = `fri17-${runId}`;
  const { data: event, error: eventErr } = await admin
    .from("events")
    .insert({
      host_id: bUser.user.id,
      name: `FRI-17 verify (${runId})`,
      slug,
      tier: "pending",
      status: "active",
    })
    .select("id")
    .single();
  if (eventErr || !event) throw new Error(`event insert failed: ${eventErr?.message}`);
  created.eventId = event.id;
  ok(`host-B event created · id=${event.id}`);

  const contentHash = `verify-${runId}`;
  const { data: media, error: mediaErr } = await admin
    .from("media")
    .insert({
      event_id: event.id,
      uploader_token: null,
      uploader_name: null,
      storage_path: `events/${event.id}/verify-${randomUUID()}.jpg`,
      kind: "photo",
      bytes: 1,
      content_hash: contentHash,
      // FRI-30 renamed media statuses: approved is the old 'active'.
      status: "approved",
    })
    .select("id")
    .single();
  if (mediaErr || !media) throw new Error(`media insert failed: ${mediaErr?.message}`);
  created.mediaId = media.id;
  ok(`host-B media row created · id=${media.id}`);

  // ---- Auth helpers -------------------------------------------------------
  // Sign in via the Supabase auth REST endpoint and turn the resulting
  // session into the exact cookie value @supabase/ssr expects. The SSR
  // library stores the session as `base64-<b64(JSON.stringify(session))>`
  // under `sb-<ref>-auth-token`. Values under ~3600 bytes fit in a single
  // cookie without chunking; our sessions are ~1.5 KB so we can send one.
  async function signIn(email) {
    const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      throw new Error(`signIn(${email}) failed: HTTP ${res.status} ${await res.text()}`);
    }
    const session = await res.json();
    const cookieValue =
      "base64-" +
      Buffer.from(
        JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
          expires_in: session.expires_in,
          token_type: session.token_type,
          user: session.user,
        }),
      ).toString("base64");
    return { session, cookieValue };
  }

  async function callDelete(cookieValue, targetEventId, ids) {
    return fetch(`${appUrl}/api/events/${targetEventId}/media/delete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${AUTH_COOKIE_NAME}=${cookieValue}`,
      },
      body: JSON.stringify({ ids }),
    });
  }

  // ---- Negative test: host-A tries to delete host-B's media ---------------
  console.log("\nCross-host attack: host-A → host-B's event…");
  const aAuth = await signIn(hostAEmail);
  ok("host-A signed in");

  const attackRes = await callDelete(aAuth.cookieValue, event.id, [media.id]);
  const attackBody = await attackRes.json().catch(() => ({}));
  if (attackRes.status === 404) {
    ok(`host-A denied with 404 (${JSON.stringify(attackBody)})`);
  } else {
    bad(
      `expected 404, got HTTP ${attackRes.status} · body=${JSON.stringify(attackBody)}`,
    );
  }

  // Belt-and-braces: even if the endpoint mysteriously returned 200, the
  // DB row should still be untouched. Re-read via service role.
  {
    const { data, error } = await admin
      .from("media")
      .select("status")
      .eq("id", media.id)
      .single();
    if (error) throw error;
    if (data.status === "approved") ok(`host-B's media still status='approved' in DB`);
    else bad(`host-B's media status changed to '${data.status}' — cross-host attack succeeded`);
  }

  // ---- Positive control: host-B deletes their own media -------------------
  console.log("\nPositive control: host-B → host-B's own event…");
  const bAuth = await signIn(hostBEmail);
  ok("host-B signed in");

  const okRes = await callDelete(bAuth.cookieValue, event.id, [media.id]);
  const okBody = await okRes.json().catch(() => ({}));
  if (okRes.status === 200 && Array.isArray(okBody.deleted) && okBody.deleted.includes(media.id)) {
    ok(`host-B deleted own media (${JSON.stringify(okBody)})`);
  } else {
    bad(
      `expected 200 with deleted=[${media.id}], got HTTP ${okRes.status} · body=${JSON.stringify(okBody)}`,
    );
  }

  {
    const { data, error } = await admin
      .from("media")
      .select("status")
      .eq("id", media.id)
      .single();
    if (error) throw error;
    if (data.status === "rejected") ok(`host-B's media flipped to status='rejected' in DB`);
    else bad(`expected status='rejected', got '${data.status}'`);
  }
} finally {
  await cleanup();
}

if (process.exitCode) {
  console.log("\nFAILED — see errors above.\n");
} else {
  console.log("\nPASSED — cross-host delete is denied, positive control works.\n");
}

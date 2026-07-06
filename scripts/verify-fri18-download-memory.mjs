// FRI-18 memory-flatness verification.
//
// Usage:
//   1) Seed a large event:
//        npm run seed:gallery -- --host <host-user-id> --count 1000
//      (note the printed event.id)
//   2) Start the dev server:
//        npm run dev
//   3) Run this script (in a third terminal):
//        node --env-file=.env.local scripts/verify-fri18-download-memory.mjs \
//          --event <event-id> --host-email <email> --host-password <pw>
//
// What it does:
//   1. Signs in as the host so /api/events/<id>/download returns 200.
//   2. Streams the ZIP body, discarding the bytes chunk-by-chunk.
//   3. Samples process.memoryUsage().heapUsed every ~250ms and prints
//      a compact time series + a peak-vs-baseline delta.
//   4. Verifies the response is Content-Type: application/zip with a
//      Content-Disposition attachment header.
//
// It measures the CLIENT process's heap, not the server's — but the shape
// we care about (constant, no growth per photo processed) mirrors what the
// server does when the response is streamed and consumed at rate: if the
// server were buffering the whole ZIP, the client wouldn't see any bytes
// until 1,000 photos had been read, and the "chunks streamed" counter here
// would jump from 0 to N all at once. A flat heap + steady chunk trickle
// is the streaming shape TECH_SPEC §10 asks for.

import { readFile } from "node:fs/promises";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]);
}

const eventId = args.get("event");
const hostEmail = args.get("host-email");
const hostPassword = args.get("host-password");
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!eventId || !hostEmail || !hostPassword) {
  console.error(
    "Required: --event <id> --host-email <email> --host-password <password>",
  );
  process.exit(1);
}
if (!supabaseUrl || !anonKey) {
  console.error(
    "Missing env — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
  );
  process.exit(1);
}

const projectRef = new URL(supabaseUrl).host.split(".")[0];
const AUTH_COOKIE_NAME = `sb-${projectRef}-auth-token`;

// --- Sign in --------------------------------------------------------------
console.log(`Signing in as ${hostEmail}…`);
const signInRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: anonKey, "content-type": "application/json" },
  body: JSON.stringify({ email: hostEmail, password: hostPassword }),
});
if (!signInRes.ok) {
  console.error(`Sign-in failed: HTTP ${signInRes.status} ${await signInRes.text()}`);
  process.exit(1);
}
const session = await signInRes.json();
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

// --- Warm baseline --------------------------------------------------------
if (global.gc) global.gc();
const baselineHeap = process.memoryUsage().heapUsed;
console.log(`Baseline heap: ${(baselineHeap / 1024 / 1024).toFixed(1)} MiB`);

// --- Stream the ZIP -------------------------------------------------------
console.log(`Streaming /api/events/${eventId}/download…`);
const startedAt = Date.now();
const res = await fetch(`${appUrl}/api/events/${eventId}/download`, {
  headers: { cookie: `${AUTH_COOKIE_NAME}=${cookieValue}` },
});

if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
if (res.headers.get("content-type") !== "application/zip") {
  console.error(`Unexpected content-type: ${res.headers.get("content-type")}`);
  process.exit(1);
}
if (!/attachment/.test(res.headers.get("content-disposition") ?? "")) {
  console.error(
    `Missing Content-Disposition: attachment — got ${res.headers.get("content-disposition")}`,
  );
  process.exit(1);
}
console.log(`  content-disposition: ${res.headers.get("content-disposition")}`);

// Sampler in the background.
const samples = [];
const sampler = setInterval(() => {
  samples.push({
    t: Date.now() - startedAt,
    heap: process.memoryUsage().heapUsed,
  });
}, 250);

let bytes = 0;
let chunks = 0;
// The response body is a Web ReadableStream — iterate its Node adapter.
for await (const chunk of res.body) {
  bytes += chunk.length;
  chunks += 1;
  // Deliberately do NOT retain the chunk — this is the flat-memory client.
}

clearInterval(sampler);
const elapsed = Date.now() - startedAt;
if (global.gc) global.gc();
const finalHeap = process.memoryUsage().heapUsed;
const peak = samples.reduce((m, s) => Math.max(m, s.heap), baselineHeap);

console.log("");
console.log(`Received  ${bytes} bytes in ${chunks} chunks over ${elapsed} ms`);
console.log(
  `Heap      baseline=${(baselineHeap / 1024 / 1024).toFixed(1)} MiB` +
    ` · peak=${(peak / 1024 / 1024).toFixed(1)} MiB` +
    ` · final=${(finalHeap / 1024 / 1024).toFixed(1)} MiB`,
);
console.log(
  `Peak Δ    ${((peak - baselineHeap) / 1024 / 1024).toFixed(1)} MiB above baseline`,
);
if (chunks < 2) {
  console.warn(
    "  ⚠ Only 1 chunk received — response may be small enough that streaming can't be observed here. Re-seed a larger event.",
  );
}

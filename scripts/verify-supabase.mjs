// FRI-6 verification: confirms the Supabase project is wired up correctly.
// Run after filling .env.local:
//   npm run verify:supabase
// (loads .env.local via Node's --env-file — Node 20.6+/22)

import { createClient } from "@supabase/supabase-js";

const REQUIRED_TABLES = ["profiles", "events", "media", "payments"];
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "event-media";

let failed = false;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  failed = true;
  console.error(`  ✗ ${m}`);
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) bad(`missing env var ${name}`);
  return v;
}

console.log("\ngather.photo — Supabase setup check\n");

console.log("Environment:");
const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const tusEndpoint = requireEnv("NEXT_PUBLIC_SUPABASE_TUS_ENDPOINT");
if (!failed) ok("all required env vars present");

if (!url || !serviceKey) {
  console.error("\nCannot continue without URL + service-role key.\n");
  process.exit(1);
}

// Service-role client bypasses RLS so we can confirm tables exist.
const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

console.log("\nTables:");
for (const table of REQUIRED_TABLES) {
  // Use a real GET (not head:true) so error bodies are returned and readable.
  const { error } = await supabase.from(table).select("id").limit(1);
  if (error) {
    const detail =
      [error.code, error.message, error.hint].filter(Boolean).join(" · ") ||
      JSON.stringify(error);
    bad(`table "${table}" — ${detail}`);
  } else ok(`table "${table}" exists`);
}

console.log("\nStorage:");
const { data: buckets, error: bucketErr } = await supabase.storage.listBuckets();
if (bucketErr) {
  bad(`could not list buckets — ${bucketErr.message}`);
} else {
  const bucket = buckets.find((b) => b.name === BUCKET);
  if (!bucket) bad(`bucket "${BUCKET}" not found`);
  else if (bucket.public) bad(`bucket "${BUCKET}" is PUBLIC — it must be private`);
  else ok(`private bucket "${BUCKET}" exists`);
}

console.log("\nResumable (TUS) endpoint:");
try {
  // A bare request returns an HTTP error, but any response means it's reachable.
  const res = await fetch(tusEndpoint, { method: "OPTIONS" });
  ok(`reachable (HTTP ${res.status}) at ${tusEndpoint}`);
} catch (e) {
  bad(`TUS endpoint unreachable — ${e.message}`);
}

console.log(failed ? "\nFAILED — fix the items above.\n" : "\nAll checks passed. FRI-6 is good.\n");
process.exit(failed ? 1 : 0);

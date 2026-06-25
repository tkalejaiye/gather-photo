import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role Supabase client — bypasses RLS. SERVER-ONLY. Never import this
// from client code. Used for guest-facing reads where RLS would block the
// anon role (e.g. resolving an event by its unguessable slug — privacy is
// the slug itself, not row-level policies).
export function createServiceClient() {
  // Belt-and-braces: if this somehow gets bundled into a client chunk, fail
  // loudly rather than try to hit Supabase from the browser with a missing
  // key. The proper guard would be the `server-only` npm package, but the
  // sandbox can't install deps; this catches the regression at runtime.
  if (typeof window !== "undefined") {
    throw new Error("createServiceClient is server-only.");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL) must be set on the server.",
    );
  }
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

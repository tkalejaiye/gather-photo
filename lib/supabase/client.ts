import { createBrowserClient } from "@supabase/ssr";

// Browser Supabase client (anon key). RLS applies. Never import the
// service role key here — that is server-only.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

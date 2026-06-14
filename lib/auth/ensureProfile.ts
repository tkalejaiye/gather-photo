import type { SupabaseClient } from "@supabase/supabase-js";

// Idempotent — upsert by primary key. The profiles RLS policy allows
// auth.uid() = id, so this works under the authenticated client.
export async function ensureProfile(supabase: SupabaseClient, userId: string) {
  const { error } = await supabase
    .from("profiles")
    .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
}

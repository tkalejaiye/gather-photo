import type { SupabaseClient, User } from "@supabase/supabase-js";

// Idempotent — upsert by primary key. The profiles RLS policy allows
// auth.uid() = id, so this works under the authenticated client.
export async function ensureProfile(
  supabase: SupabaseClient,
  user: Pick<User, "id" | "user_metadata">,
) {
  const { error } = await supabase
    .from("profiles")
    .upsert({ id: user.id }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;

  // Sign-up captures the host's name into auth user_metadata (FRI-35). Copy
  // it onto the profile row, but only while full_name is unset — a name the
  // host later edits must not be clobbered by stale signup metadata.
  const raw = user.user_metadata?.full_name;
  const fullName = typeof raw === "string" ? raw.trim() : "";
  if (!fullName) return;

  const { error: backfillError } = await supabase
    .from("profiles")
    .update({ full_name: fullName })
    .eq("id", user.id)
    .is("full_name", null);
  if (backfillError) throw backfillError;
}

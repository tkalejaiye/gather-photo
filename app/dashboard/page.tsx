import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/auth/ensureProfile";
import { SignOutButton } from "./SignOutButton";

// Host dashboard — gallery grid, counts, delete, ZIP download (M3).
// FRI-7: gated behind Supabase auth; unauthenticated visitors land on /sign-in.

export default async function DashboardPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  // Idempotent — guarantees a profiles row exists for every signed-in host,
  // including users created out-of-band (Supabase dashboard/CLI).
  await ensureProfile(supabase, user.id);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand">Your events</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-300">
          <span>{user.email ?? user.phone}</span>
          <SignOutButton />
        </div>
      </header>
      <p className="mt-2 text-sm text-neutral-400">
        Stub. Gallery + ZIP download arrive in M3. See TECH_SPEC.md §6.
      </p>
    </main>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/auth/ensureProfile";
import { SignOutButton } from "./SignOutButton";

// Host dashboard — gallery grid, counts, delete, ZIP download (M3).
// FRI-7: gated behind Supabase auth.
// FRI-8: lists the host's events and links to the create-event flow.

export default async function DashboardPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  // Idempotent — guarantees a profiles row exists for every signed-in host,
  // including users created out-of-band (Supabase dashboard/CLI).
  await ensureProfile(supabase, user.id);

  const { data: events } = await supabase
    .from("events")
    .select("id, name, slug, event_date, status, created_at")
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand">Your events</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-300">
          <span>{user.email ?? user.phone}</span>
          <SignOutButton />
        </div>
      </header>

      <div className="mt-6 flex items-center justify-between">
        <p className="text-sm text-neutral-400">
          {events?.length
            ? `${events.length} event${events.length === 1 ? "" : "s"}`
            : "No events yet."}
        </p>
        <Link
          href="/dashboard/new"
          className="rounded bg-brand px-3 py-1.5 text-sm font-medium text-white"
        >
          New event
        </Link>
      </div>

      {events && events.length > 0 ? (
        <ul className="mt-4 divide-y divide-neutral-800 rounded border border-neutral-800">
          {events.map((e) => (
            <li key={e.id}>
              <Link
                href={`/dashboard/events/${e.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-neutral-900"
              >
                <div>
                  <div className="text-sm font-medium text-neutral-100">
                    {e.name}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {e.event_date ?? "no date"} · /e/{e.slug}
                  </div>
                </div>
                <span className="text-xs uppercase tracking-wide text-neutral-400">
                  {e.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-neutral-500">
          Gallery + ZIP download arrive in M3. See TECH_SPEC.md §6.
        </p>
      )}
    </main>
  );
}

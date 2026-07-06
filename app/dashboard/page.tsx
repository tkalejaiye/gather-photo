import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/auth/ensureProfile";
import { SignOutButton } from "./SignOutButton";

// Host dashboard — gallery grid, counts, delete, ZIP download (M3).
// FRI-7: gated behind Supabase auth.
// FRI-8: lists the host's events and links to the create-event flow.
// FRI-26: visual pass — dark canvas, cards, pill CTAs.

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
    <main className="app-shell min-h-screen px-6 py-10">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/"
            className="h-eyebrow inline-flex items-center gap-1 text-ink-300 transition hover:text-white"
          >
            gather.photo
          </Link>
          <div className="flex items-center gap-3 text-sm text-ink-200">
            <span className="hidden sm:inline">{user.email ?? user.phone}</span>
            <SignOutButton />
          </div>
        </header>

        <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="h-eyebrow">Your events</p>
            <h1 className="h-display mt-1 text-4xl sm:text-5xl">
              What are we shooting? 📸
            </h1>
            <p className="mt-2 text-sm text-ink-200">
              {events?.length
                ? `${events.length} event${events.length === 1 ? "" : "s"} · tap to open`
                : "Spin up your first event — takes about 20 seconds."}
            </p>
          </div>
          <Link href="/dashboard/new" className="btn-pop">
            + New event
          </Link>
        </div>

        {events && events.length > 0 ? (
          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {events.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/dashboard/events/${e.id}`}
                  className="card block transition hover:-translate-y-0.5 hover:border-white/20 focus:border-white/30 focus:outline-none"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-lg font-semibold text-white">
                        {e.name}
                      </div>
                      <div className="mt-1 text-xs text-ink-300">
                        {e.event_date ?? "no date"} · /e/{e.slug}
                      </div>
                    </div>
                    <StatusBadge status={e.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card mt-8 text-center">
            <p className="mx-auto max-w-md text-sm text-ink-200">
              Every event you create gets its own QR code + private gallery.
              Guests scan, shoot, and every photo lands here.
            </p>
            <Link href="/dashboard/new" className="btn-plum mt-5 inline-flex">
              Create your first event
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isOpen = status === "open";
  return (
    <span
      className={
        isOpen
          ? "chip chip-active shrink-0"
          : "chip shrink-0"
      }
    >
      {status}
    </span>
  );
}

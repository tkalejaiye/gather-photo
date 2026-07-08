import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/auth/ensureProfile";
import { daylightButtonClasses } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/eyebrow";
import { ScreenShell } from "@/components/ui/screen-shell";
import { Wordmark } from "@/components/ui/wordmark";
import { SignOutButton } from "./SignOutButton";
import { StatusChip, fullDate } from "./status";

// Host dashboard — events list. FRI-7 gated it behind Supabase auth, FRI-8
// added the list + create link. FRI-36: Daylight. This screen has no mock;
// it's derived from the tokens (design/daylight/README.md §Design Tokens):
// wordmark header, paper cards, status chips.

export default async function DashboardPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  // Idempotent — guarantees a profiles row exists for every signed-in host,
  // including users created out-of-band (Supabase dashboard/CLI).
  await ensureProfile(supabase, user);

  const { data: events } = await supabase
    .from("events")
    .select("id, name, slug, event_date, status, created_at")
    .order("created_at", { ascending: false });

  return (
    <ScreenShell>
      <main className="mx-auto w-full max-w-[960px] px-[26px] pb-16 pt-12 lg:px-10">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Wordmark />
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-xs text-daylight-muted sm:inline">
              {user.email ?? user.phone}
            </span>
            <SignOutButton />
          </div>
        </header>

        <div className="mt-12 flex flex-wrap items-end justify-between gap-5">
          <div>
            <Eyebrow>YOUR EVENTS</Eyebrow>
            <h1 className="mt-2 font-display text-[34px] leading-[0.95] tracking-[0.005em] text-daylight-ink">
              What are we shooting?
            </h1>
            <p className="mt-3 font-mono text-[13px] text-daylight-muted">
              {events?.length
                ? `${events.length} event${events.length === 1 ? "" : "s"} · tap to open`
                : "Your first event takes about 20 seconds."}
            </p>
          </div>
          <Link
            href="/dashboard/new"
            className={daylightButtonClasses("primary", "!px-6 !py-3.5 text-sm")}
          >
            + New event
          </Link>
        </div>

        {events && events.length > 0 ? (
          <ul className="mt-7 grid gap-3.5 sm:grid-cols-2">
            {events.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/dashboard/events/${e.id}`}
                  className="block rounded-daylight-card-lg border border-daylight-rule bg-white/55 p-[18px] shadow-daylight-card-sm transition hover:-translate-y-0.5 hover:shadow-daylight-card focus:outline-none focus-visible:border-daylight-orange focus-visible:shadow-daylight-focus"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-display text-lg uppercase leading-tight text-daylight-ink">
                        {e.name}
                      </div>
                      <div className="mt-2 font-mono text-[11px] text-daylight-muted">
                        {e.event_date ? fullDate(e.event_date) : "No date"} ·{" "}
                        /e/{e.slug}
                      </div>
                    </div>
                    <StatusChip status={e.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-7 rounded-daylight-card-lg border border-daylight-rule bg-white/55 p-8 text-center shadow-daylight-card-sm">
            <p className="mx-auto max-w-md text-[15px] leading-relaxed text-daylight-ink-soft">
              Every event you create gets its own QR code + a live roll.
              Guests scan, shoot, and every photo lands here.
            </p>
            <Link
              href="/dashboard/new"
              className={daylightButtonClasses("primary", "mt-6 !px-7 !py-4 text-sm")}
            >
              Create your first event
            </Link>
          </div>
        )}
      </main>
    </ScreenShell>
  );
}

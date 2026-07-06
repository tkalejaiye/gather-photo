import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createEventFromForm } from "@/lib/events/actions";

export const metadata = { title: "New event · gather.photo" };

type Props = { searchParams: { error?: string } };

export default async function NewEventPage({ searchParams }: Props) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  return (
    <main className="app-shell min-h-screen px-6 py-10">
      <div className="mx-auto max-w-md">
        <Link
          href="/dashboard"
          className="h-eyebrow inline-flex items-center gap-1 text-ink-300 transition hover:text-white"
        >
          ← Back
        </Link>
        <div className="card mt-5">
          <p className="h-eyebrow">New event</p>
          <h1 className="h-display mt-1 text-4xl">Let&apos;s roll.</h1>
          <p className="mt-2 text-sm text-ink-200">
            You&apos;ll get a QR code + link to share with your guests.
          </p>
          {searchParams.error && (
            <p className="banner-error mt-5" role="alert">
              {searchParams.error}
            </p>
          )}
          <form action={createEventFromForm} className="mt-6 space-y-4">
            <label className="block">
              <span className="field-label">Event name</span>
              <input
                name="name"
                required
                maxLength={120}
                placeholder="Tunde & Amaka — Lagos 2026"
                className="input mt-2"
              />
            </label>
            <label className="block">
              <span className="field-label">Date (optional)</span>
              <input
                name="event_date"
                type="date"
                className="input mt-2"
              />
            </label>
            <label className="block">
              <span className="field-label">PIN (optional, 4–8 digits)</span>
              <input
                name="pin"
                inputMode="numeric"
                pattern="[0-9]{4,8}"
                placeholder="e.g. 2468"
                className="input mt-2 tracking-[0.4em]"
              />
              <span className="mt-2 block text-xs text-ink-300">
                Adds an extra gate before guests can upload.
              </span>
            </label>
            <button type="submit" className="btn-pop w-full">
              Create event →
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

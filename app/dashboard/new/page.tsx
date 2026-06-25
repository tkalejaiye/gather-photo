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

  const inputClass =
    "w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none";

  return (
    <main className="mx-auto max-w-md px-6 py-10">
      <Link
        href="/dashboard"
        className="text-xs uppercase tracking-wide text-neutral-400 hover:text-neutral-200"
      >
        ← Back
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-brand">Create event</h1>
      <p className="mt-2 text-sm text-neutral-400">
        You&apos;ll get a QR code and link to share with your guests.
      </p>
      {searchParams.error && (
        <p className="mt-4 rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {searchParams.error}
        </p>
      )}
      <form action={createEventFromForm} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-neutral-400">
            Event name
          </span>
          <input
            name="name"
            required
            maxLength={120}
            placeholder="Tunde & Amaka — Lagos 2026"
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-neutral-400">
            Date (optional)
          </span>
          <input name="event_date" type="date" className={`mt-1 ${inputClass}`} />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-neutral-400">
            PIN (optional, 4–8 digits)
          </span>
          <input
            name="pin"
            inputMode="numeric"
            pattern="[0-9]{4,8}"
            placeholder="e.g. 2468"
            className={`mt-1 ${inputClass}`}
          />
          <span className="mt-1 block text-xs text-neutral-500">
            Adds an extra gate before guests can upload.
          </span>
        </label>
        <button
          type="submit"
          className="w-full rounded bg-brand px-4 py-2 text-sm font-medium text-white"
        >
          Create event
        </button>
      </form>
    </main>
  );
}

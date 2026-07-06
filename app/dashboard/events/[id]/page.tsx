import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { CopyLinkButton } from "./CopyLinkButton";
import { GalleryGrid } from "./GalleryGrid";
import {
  DEFAULT_PAGE_SIZE,
  fetchTotalCount,
  fetchUploaderSummary,
  loadGalleryPage,
} from "@/lib/gallery/queries";

export const metadata = { title: "Event · gather.photo" };
// Signed URLs are short-lived; caching the initial HTML would hand a returning
// host a stale URL from a prior render. `no-store` is cheap here — this route
// is host-only and low-traffic.
export const dynamic = "force-dynamic";

export default async function EventDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  // RLS scopes this select to the host's own events.
  const { data: event } = await supabase
    .from("events")
    .select("id, name, slug, pin, event_date, status, created_at")
    .eq("id", params.id)
    .maybeSingle();
  if (!event) notFound();

  // Fan the three gallery reads out in parallel — they hit independent
  // indexes and don't depend on one another.
  const [initialPage, mediaCount, uploaders] = await Promise.all([
    loadGalleryPage(supabase, event.id, { offset: 0, limit: DEFAULT_PAGE_SIZE }),
    fetchTotalCount(supabase, event.id),
    fetchUploaderSummary(supabase, event.id),
  ]);

  // Fail loud if a prod deploy forgot to set this — a localhost QR on a
  // wedding card is a much worse outcome than a 500.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("NEXT_PUBLIC_APP_URL must be set in production.");
    }
  }
  const guestUrl = `${appUrl ?? "http://localhost:3000"}/e/${event.slug}`;
  // Server-rendered QR keeps the host bundle free of the qrcode package.
  // Error-correction M = ~15% damage tolerance — enough for print at A6.
  const qrDataUrl = await QRCode.toDataURL(guestUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
  });

  const isOpen = event.status === "open";

  return (
    <main className="app-shell min-h-screen px-6 py-10">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/dashboard"
          className="h-eyebrow inline-flex items-center gap-1 text-ink-300 transition hover:text-white"
        >
          ← All events
        </Link>
        <header className="mt-5 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="h-eyebrow">Event</p>
            <h1 className="h-display mt-1 text-4xl sm:text-5xl">{event.name}</h1>
            <p className="mt-2 text-sm text-ink-200">
              {event.event_date ?? "No date set"}
              {event.pin ? " · PIN required" : ""}
            </p>
          </div>
          <span
            className={isOpen ? "chip chip-active" : "chip"}
            aria-label={`Status: ${event.status}`}
          >
            {event.status}
          </span>
        </header>

        <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
          <section className="card">
            <p className="h-eyebrow">Guest link</p>
            <h2 className="mt-1 text-lg font-semibold text-white">
              Share this to collect photos
            </h2>
            <p className="mt-1 text-xs text-ink-300">
              Anyone with this link can upload photos.
              {event.pin ? " They will also need the PIN." : ""}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white">
                {guestUrl}
              </code>
              <CopyLinkButton url={guestUrl} />
            </div>
          </section>

          <section className="card flex flex-col items-center text-center">
            <p className="h-eyebrow">QR code</p>
            <p className="mt-1 max-w-[220px] text-xs text-ink-300">
              Print for signage — guests scan with their phone camera.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrDataUrl}
              alt={`QR code for ${guestUrl}`}
              width={240}
              height={240}
              className="mt-3 h-56 w-56 rounded-2xl bg-white p-3 shadow-plum"
            />
          </section>
        </div>

        <GalleryGrid
          eventId={event.id}
          totalCount={mediaCount}
          uploaders={uploaders}
          initialPage={initialPage}
        />
      </div>
    </main>
  );
}

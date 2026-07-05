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

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href="/dashboard"
        className="text-xs uppercase tracking-wide text-neutral-400 hover:text-neutral-200"
      >
        ← Back
      </Link>
      <header className="mt-4 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold text-brand">{event.name}</h1>
        <span className="text-xs uppercase tracking-wide text-neutral-400">
          {event.status}
        </span>
      </header>
      <p className="mt-1 text-sm text-neutral-500">
        {event.event_date ?? "no date set"}
        {event.pin ? " · PIN required" : ""}
      </p>

      <section className="mt-8 rounded border border-neutral-800 p-6">
        <h2 className="text-sm font-medium text-neutral-200">Guest link</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Anyone with this link can upload photos.
          {event.pin ? " They will also need the PIN." : ""}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 truncate rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200">
            {guestUrl}
          </code>
          <CopyLinkButton url={guestUrl} />
        </div>
      </section>

      <GalleryGrid
        eventId={event.id}
        totalCount={mediaCount}
        uploaders={uploaders}
        initialPage={initialPage}
      />

      <section className="mt-6 rounded border border-neutral-800 p-6">
        <h2 className="text-sm font-medium text-neutral-200">QR code</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Print this on signage. Guests scan with their phone camera.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={qrDataUrl}
          alt={`QR code for ${guestUrl}`}
          width={320}
          height={320}
          className="mt-4 h-80 w-80 rounded bg-white p-2"
        />
      </section>
    </main>
  );
}

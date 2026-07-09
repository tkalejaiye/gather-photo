import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { backButtonClasses } from "@/components/ui/back-button";
import { daylightButtonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Eyebrow } from "@/components/ui/eyebrow";
import { ScreenShell } from "@/components/ui/screen-shell";
import { Wordmark } from "@/components/ui/wordmark";
import { statusLine } from "../../status";
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

// "Roll Control" — Daylight screen 13 on mobile, desktop anchor D4 (dark ink
// sidebar + 320px share/stats column + Recent uploads pane) at lg and up.
// Overrides vs the mock (FRI-36 decision log): stats are SHOTS + CROWD only
// (no view tracking → no LOOKS), the ZIP download stays prominent (PRD §7),
// and moderation keeps the FRI-17 delete flow — the mock's tap-to-hide
// overlay becomes the FRI-30 approval UI, not this.

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
    .select("id, name, slug, pin, event_date, status, uploads_close_at, created_at")
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
  const guestUrlDisplay = guestUrl.replace(/^https?:\/\//, "");
  // Server-rendered QR keeps the host bundle free of the qrcode package.
  // Error-correction M = ~15% damage tolerance — enough for print at A6.
  const qrDataUrl = await QRCode.toDataURL(guestUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
  });

  const isLive = event.status === "active";
  const line = statusLine(event.status, event.uploads_close_at);

  return (
    <ScreenShell contentClassName="lg:flex-row">
      {/* D4 sidebar — dark ink, event-scoped: its nav items are sections
          WITHIN this event (FRI-30 moderation and FRI-37 The Roll slot in
          here), so every nav destination keeps the sidebar. Leaving the
          event happens through the wordmark or the pinned current-event
          card (the mock's ▾ switcher) — both go to /dashboard. */}
      <aside className="hidden bg-daylight-ink px-5 py-7 lg:flex lg:w-[244px] lg:shrink-0 lg:flex-col">
        <Link href="/dashboard" aria-label="Back to your events" className="self-start">
          <Wordmark tone="paper" />
        </Link>
        <nav className="mt-9 flex flex-col gap-1" aria-label="Event sections">
          <span
            aria-current="page"
            className="flex items-center gap-3 rounded-[11px] bg-daylight-orange-grad px-3.5 py-3 text-sm font-bold text-white"
          >
            <span aria-hidden>▨</span> Overview
          </span>
        </nav>
        <div className="flex-1" />
        <Link
          href="/dashboard"
          aria-label="Switch event"
          className="block rounded-[13px] bg-white/[0.07] p-4 transition hover:bg-white/[0.12]"
        >
          <div className="font-mono text-[11px] tracking-[0.1em] text-daylight-muted">
            CURRENT EVENT
          </div>
          <div className="mt-1.5 break-words font-display text-sm leading-snug text-daylight-paper">
            {event.name}
          </div>
          <div className="mt-1 font-mono text-[11px] text-[#b7a988]">{line} ▾</div>
        </Link>
      </aside>

      <main className="mx-auto w-full max-w-[1060px] flex-1 px-[22px] pb-12 pt-14 lg:px-9 lg:pt-[34px]">
        {/* Mobile top row: back + eyebrow (mock screen 13). */}
        <div className="flex items-center justify-between lg:hidden">
          <Link
            href="/dashboard"
            aria-label="Back to your events"
            className={backButtonClasses()}
          >
            ←
          </Link>
          <Eyebrow>ROLL CONTROL</Eyebrow>
        </div>

        <header className="mt-5 flex items-start justify-between gap-4 lg:mt-0">
          <div className="min-w-0">
            <Eyebrow className="hidden items-center gap-2.5 lg:flex">
              {isLive && (
                <span
                  aria-hidden
                  className="h-2 w-2 animate-gp-blink rounded-full bg-daylight-orange shadow-[0_0_8px_rgba(255,106,0,0.7)]"
                />
              )}
              ROLL CONTROL{isLive ? " · LIVE" : ""}
            </Eyebrow>
            <h1 className="mt-2 break-words font-display text-[30px] uppercase leading-[0.95] tracking-[0.005em] text-daylight-ink lg:mt-2 lg:text-[38px]">
              {event.name}
            </h1>
            <p className="mt-2 font-mono text-[13px] text-daylight-muted">
              {line}
              {event.pin ? " · PIN required" : ""}
            </p>
          </div>
          <Link
            href={`/e/${event.slug}`}
            className="hidden shrink-0 items-center gap-1.5 rounded-[12px] bg-daylight-orange-grad px-5 py-3 font-display text-[13px] uppercase text-white shadow-[0_10px_24px_rgba(255,106,0,0.32)] transition active:scale-[0.97] lg:inline-flex"
          >
            {/* ︎ forces text presentation — U+2197 alone may render as
                an emoji arrow on Apple platforms. */}
            View live roll {"↗︎"}
          </Link>
        </header>

        <div className="mt-6 lg:flex lg:items-start lg:gap-[22px]">
          {/* Left column: share card, stats, ZIP (D4); stacks first on mobile. */}
          <div className="flex flex-col gap-3.5 lg:w-[320px] lg:shrink-0">
            <section
              aria-label="Guest link"
              className="flex items-center gap-4 rounded-daylight-card-lg border border-daylight-rule bg-white/55 p-[18px] shadow-daylight-card lg:flex-col lg:gap-0 lg:border-daylight-rule-light lg:bg-white lg:p-[22px] lg:text-center"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrDataUrl}
                alt={`QR code for ${guestUrl}`}
                width={320}
                height={320}
                className="h-[108px] w-[108px] shrink-0 rounded-[12px] bg-white p-2 shadow-daylight-card-sm lg:h-[170px] lg:w-[170px] lg:p-3"
              />
              <div className="min-w-0 flex-1 lg:mt-4 lg:w-full lg:flex-none">
                <div className="font-mono text-[10px] font-bold tracking-[0.12em] text-daylight-muted lg:text-[11px]">
                  GUEST LINK
                </div>
                <div className="mt-1.5 break-all font-mono text-sm font-bold text-daylight-ink lg:text-[15px]">
                  {guestUrlDisplay}
                </div>
                <CopyLinkButton url={guestUrl} className="mt-3 lg:w-full lg:py-3" />
              </div>
            </section>

            <div className="flex gap-2.5">
              <StatCard value={mediaCount} label="SHOTS" accent />
              <StatCard value={uploaders.length} label="CROWD" />
            </div>

            {mediaCount > 0 && (
              /* FRI-18: streamed ZIP export. A plain <a> beats fetch()+Blob
                 because the browser can spool multi-GB responses to disk
                 as they arrive, whereas Blob buffers the whole payload. */
              <a
                href={`/api/events/${event.id}/download`}
                className={daylightButtonClasses("secondary", "w-full")}
                aria-label="Download all photos as ZIP"
              >
                {/* U+2193, not U+2B07 — the latter defaults to emoji
                    presentation on iOS (blue square). */}
                ↓ DOWNLOAD ZIP
              </a>
            )}
          </div>

          {/* Right pane: Recent uploads moderation grid (D4). */}
          <section className="mt-7 lg:mt-0 lg:min-w-0 lg:flex-1 lg:self-start lg:rounded-daylight-card-lg lg:border lg:border-daylight-rule-light lg:bg-white/50 lg:p-[22px] lg:shadow-daylight-card-sm">
            <GalleryGrid
              eventId={event.id}
              totalCount={mediaCount}
              uploaders={uploaders}
              initialPage={initialPage}
            />
          </section>
        </div>

        {/* Mobile footer (mock screen 13). */}
        <div className="mt-8 lg:hidden">
          <Link
            href={`/e/${event.slug}`}
            className={daylightButtonClasses("secondary", "w-full")}
          >
            VIEW LIVE ROLL
          </Link>
        </div>
      </main>
    </ScreenShell>
  );
}

// Compact so a 1,400-shot wedding reads "1.4k" like the mock, not a
// four-digit pile-up in a 26px face.
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  })
    .format(n)
    .toLowerCase();
}

function StatCard({
  value,
  label,
  accent = false,
}: {
  value: number;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className="flex-1 rounded-daylight-card border border-daylight-rule bg-white/50 p-4">
      <div
        className={cx(
          "font-display text-[26px]",
          accent ? "text-daylight-orange" : "text-daylight-ink",
        )}
      >
        {formatCount(value)}
      </div>
      <div className="mt-1 font-mono text-[11px] text-daylight-muted">{label}</div>
    </div>
  );
}

import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { getEventBySlug, isEventOpen } from "@/lib/events/lookup";
import { hasValidPinCookie } from "@/lib/events/pin";
import { fetchTotalCount } from "@/lib/gallery/queries";
import { createServiceClient } from "@/lib/supabase/service";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Polaroid } from "@/components/ui/polaroid";
import { ScreenShell } from "@/components/ui/screen-shell";
import { GuestFlow } from "./GuestFlow";
import { PinForm } from "./PinForm";

// Guest upload route — the critical path.
// Keep this bundle TINY (loads on low-end Android over 3G — TECH_SPEC §8).
// FRI-8: resolve the slug, 404 unknown, gate by PIN when set, honor windows.
// FRI-9: name + uploader_token in localStorage, camera + multi-select shell.
// M1: capture/select → compress → single upload.
// M2: IndexedDB queue + resumable TUS + offline resume + progress UI.
// FRI-34: Daylight redesign — Landing/Name/Picker/Uploading/Success flow
// (design/daylight/README.md §Screens 1–5) + restyled PIN/ended states.

// The route renders on warm paper now — keep the browser chrome in step.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F4E9CE",
};

type Props = {
  params: { slug: string };
  searchParams: { error?: string };
};

export default async function GuestUploadPage({ params, searchParams }: Props) {
  const event = await getEventBySlug(params.slug);
  if (!event) notFound();

  // Spec §4/§9: status + uploads_close_at + storage_expires_at all gate
  // guest access independently. Unknown slugs still 404; a *closed* event
  // renders a clear "this event has ended" page so a guest arriving late
  // from a printed QR sees why they can't upload rather than a generic
  // 404. Upload API routes stay at 404 for closed events.
  if (!isEventOpen(event)) {
    return (
      <ScreenShell contentClassName="mx-auto w-full max-w-[440px] items-center justify-center px-[26px] py-11 text-center">
        <div aria-hidden className="flex justify-center">
          <Polaroid rotate={-6} float className="w-[120px]">
            <div
              className="h-[96px]"
              style={{ background: "linear-gradient(150deg,#C98A3A,#6e3d12)" }}
            />
          </Polaroid>
        </div>
        <Eyebrow className="mt-9">That&apos;s a wrap</Eyebrow>
        <h1 className="mt-3 break-words font-display text-4xl uppercase leading-[0.95] tracking-[0.005em]">
          {event.name}
        </h1>
        <p className="mt-4 text-[15px] leading-normal text-daylight-ink-soft">
          This event has ended. Uploads are closed.
        </p>
        <p className="mt-2 font-mono text-xs text-daylight-muted">
          If you think this is a mistake, ask the host to check the event
          settings.
        </p>
      </ScreenShell>
    );
  }

  if (event.has_pin) {
    const ok = await hasValidPinCookie(event.slug);
    if (!ok) {
      return (
        <ScreenShell contentClassName="mx-auto w-full max-w-[440px] justify-center px-[26px] py-11">
          <div className="text-center">
            <Eyebrow>PIN required</Eyebrow>
            <h1 className="mt-3 break-words font-display text-[34px] uppercase leading-[0.95] tracking-[0.005em]">
              {event.name}
            </h1>
            <p className="mt-3 text-[15px] leading-normal text-daylight-ink-soft">
              This roll is PIN-protected. Enter the PIN to keep going.
            </p>
          </div>
          {searchParams.error && (
            <p
              role="alert"
              className="mt-6 rounded-daylight-field border border-daylight-red/40 bg-daylight-red/10 px-4 py-3 text-center text-sm font-bold text-daylight-red-deep"
            >
              {searchParams.error}
            </p>
          )}
          <div className="mt-6">
            <PinForm slug={event.slug} />
          </div>
        </ScreenShell>
      );
    }
  }

  // Landing pill: the event's real shot count, fetched server-side with the
  // service client — guests never query the DB (TECH_SPEC §9). One COUNT
  // per page load (head:true), same query the host dashboard uses.
  const mediaCount = await fetchTotalCount(createServiceClient(), event.id);

  return (
    <ScreenShell contentClassName="mx-auto w-full max-w-[440px]">
      <GuestFlow
        slug={event.slug}
        eventId={event.id}
        eventName={event.name}
        eventDate={event.event_date}
        mediaCount={mediaCount}
      />
    </ScreenShell>
  );
}

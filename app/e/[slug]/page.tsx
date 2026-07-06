import { notFound } from "next/navigation";
import { getEventBySlug, isEventOpen } from "@/lib/events/lookup";
import { hasValidPinCookie } from "@/lib/events/pin";
import { PinForm } from "./PinForm";
import { GuestUpload } from "./GuestUpload";

// Guest upload route — the critical path.
// Keep this bundle TINY (loads on low-end Android over 3G — TECH_SPEC §8).
// FRI-8: resolve the slug, 404 unknown, gate by PIN when set, honor windows.
// FRI-9: name + uploader_token in localStorage, camera + multi-select shell.
// M1: capture/select → compress → single upload.
// M2: IndexedDB queue + resumable TUS + offline resume + progress UI.
// FRI-26: visual pass — dark canvas, pop accent, chunky pill controls.

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
      <main className="app-shell flex min-h-screen items-center justify-center px-6 py-10">
        <div className="card mx-auto w-full max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-pill bg-white/[0.06] text-2xl">
            🎞️
          </div>
          <p className="h-eyebrow">That&apos;s a wrap</p>
          <h1 className="h-display mt-2 text-3xl">{event.name}</h1>
          <p className="mt-4 text-sm text-ink-200">
            This event has ended. Uploads are closed.
          </p>
          <p className="mt-2 text-xs text-ink-300">
            If you think this is a mistake, ask the host to check the event
            settings.
          </p>
        </div>
      </main>
    );
  }

  if (event.has_pin) {
    const ok = await hasValidPinCookie(event.slug);
    if (!ok) {
      return (
        <main className="app-shell flex min-h-screen items-center justify-center px-6 py-10">
          <div className="mx-auto w-full max-w-md">
            <p className="h-eyebrow text-center">PIN required</p>
            <h1 className="h-display mt-2 text-center text-3xl">{event.name}</h1>
            <p className="mt-3 text-center text-sm text-ink-200">
              This event is PIN-protected. Enter the PIN to keep going.
            </p>
            {searchParams.error && (
              <p className="banner-error mt-6" role="alert">
                {searchParams.error}
              </p>
            )}
            <div className="mt-6">
              <PinForm slug={event.slug} />
            </div>
          </div>
        </main>
      );
    }
  }

  return (
    <main className="app-shell min-h-screen px-5 py-8">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <header className="pt-2 text-center">
          <p className="h-eyebrow">You&apos;re on the guest list ✨</p>
          <h1 className="h-display mt-2 text-[40px] leading-[1.02]">
            Drop your photos
          </h1>
          <p className="mt-2 text-sm text-ink-200">{event.name}</p>
        </header>
        <GuestUpload slug={event.slug} eventId={event.id} />
      </div>
    </main>
  );
}

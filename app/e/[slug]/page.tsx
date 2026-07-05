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
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-semibold text-brand">{event.name}</h1>
        <p className="text-sm text-neutral-400">
          This event has ended. Uploads are closed.
        </p>
        <p className="text-xs text-neutral-500">
          If you think this is a mistake, ask the host to check the event settings.
        </p>
      </main>
    );
  }

  if (event.has_pin) {
    const ok = await hasValidPinCookie(event.slug);
    if (!ok) {
      return (
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
          <h1 className="text-2xl font-semibold text-brand">{event.name}</h1>
          <p className="text-sm text-neutral-400">
            This event is PIN-protected. Enter the PIN to continue.
          </p>
          {searchParams.error && (
            <p className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              {searchParams.error}
            </p>
          )}
          <PinForm slug={event.slug} />
        </main>
      );
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 px-6 py-10">
      <header className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold text-brand">Share your photos</h1>
        <p className="text-sm text-neutral-400">{event.name}</p>
      </header>
      <GuestUpload slug={event.slug} eventId={event.id} />
    </main>
  );
}

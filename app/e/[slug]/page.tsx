import { notFound } from "next/navigation";
import { getEventBySlug, isEventOpen } from "@/lib/events/lookup";
import { hasValidPinCookie } from "@/lib/events/pin";
import { PinForm } from "./PinForm";

// Guest upload route — the critical path.
// Keep this bundle TINY (loads on low-end Android over 3G).
// FRI-8: resolve the slug, 404 unknown, gate by PIN when set, honor windows.
// M1: capture/select → compress → single upload.
// M2: IndexedDB queue + resumable TUS + offline resume + progress UI.

type Props = {
  params: { slug: string };
  searchParams: { error?: string };
};

export default async function GuestUploadPage({ params, searchParams }: Props) {
  const event = await getEventBySlug(params.slug);
  if (!event) notFound();

  // Spec §4/§9: status + uploads_close_at + storage_expires_at all gate guest
  // access independently. Closed events 404 — no hint that the slug exists.
  if (!isEventOpen(event)) notFound();

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
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold text-brand">Share your photos</h1>
      <p className="text-neutral-600">{event.name}</p>
      <p className="text-sm text-neutral-400">
        Stub. Capture + offline-first upload land in M1/M2 (TECH_SPEC.md §5).
      </p>
    </main>
  );
}

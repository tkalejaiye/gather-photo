import { createServiceClient } from "@/lib/supabase/service";
import { getEventBySlug, isEventOpen, type EventForGuest } from "@/lib/events/lookup";
import { hasValidPinCookie } from "@/lib/events/pin";

export const MEDIA_BUCKET = "event-media";

// Centralised "is this guest allowed to write to this event" check used by
// both the sign and register routes. Returns the resolved event so callers
// don't double-query. TECH_SPEC §9: guest writes only against an active,
// unexpired event (and the PIN cookie when one is set) — slug existence
// alone is not enough.
export type ResolveOpenEventFailure = { ok: false; status: 401 | 404 };
export type ResolveOpenEventSuccess = { ok: true; event: EventForGuest };

export async function resolveOpenEvent(
  slug: string,
): Promise<ResolveOpenEventSuccess | ResolveOpenEventFailure> {
  const event = await getEventBySlug(slug);
  if (!event) return { ok: false, status: 404 };
  if (!isEventOpen(event)) return { ok: false, status: 404 };
  if (event.has_pin) {
    const okPin = await hasValidPinCookie(event.slug);
    if (!okPin) return { ok: false, status: 401 };
  }
  return { ok: true, event };
}

// Per-event object key. Scoping by `events/{id}/...` keeps the namespace
// flat enough for Supabase Storage and lets the register route enforce
// "this path belongs to this event" by string prefix.
export function buildStoragePath(eventId: string, objectId: string, ext: string): string {
  // Defensive: the caller controls ext but we restrict to a short alnum suffix
  // to keep paths predictable and avoid traversal.
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 5).toLowerCase() || "bin";
  return `events/${eventId}/${objectId}.${safeExt}`;
}

// Map a Content-Type to a short extension. JPEGs dominate the compressed
// output; the rest are best-effort.
export function extForContentType(contentType: string): string {
  switch (contentType) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
    case "image/heif":
      return "heic";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

export function createStorageClient() {
  return createServiceClient();
}

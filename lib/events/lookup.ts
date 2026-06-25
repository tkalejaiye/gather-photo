import { createServiceClient } from "@/lib/supabase/service";

// Only safe-to-render fields are exposed. The `pin` text deliberately does NOT
// leave this module — a server component might unwittingly pass an `Event`
// object to a client component, and Next.js would serialize it to the
// browser. Use `verifyEventPin` for the actual gate.
export type EventForGuest = {
  id: string;
  slug: string;
  name: string;
  event_date: string | null;
  has_pin: boolean;
  status: string;
  uploads_close_at: string | null;
  storage_expires_at: string | null;
};

// Service-role lookup: RLS on `events` only allows the owning host to read,
// but the guest page needs to resolve any slug. Privacy is enforced by the
// unguessability of the slug itself (TECH_SPEC.md §9), not by RLS.
export async function getEventBySlug(
  slug: string,
): Promise<EventForGuest | null> {
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("events")
    .select(
      "id, slug, name, event_date, pin, status, uploads_close_at, storage_expires_at",
    )
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    slug: data.slug,
    name: data.name,
    event_date: data.event_date,
    has_pin: !!data.pin,
    status: data.status,
    uploads_close_at: data.uploads_close_at,
    storage_expires_at: data.storage_expires_at,
  };
}

// Server-only — never expose to client components. Reads the raw PIN solely
// for verification inside the server action.
export async function getEventPinSecret(slug: string): Promise<string | null> {
  const svc = createServiceClient();
  const { data } = await svc
    .from("events")
    .select("pin")
    .eq("slug", slug)
    .maybeSingle();
  return data?.pin ?? null;
}

// Cheap, congestion-friendly: any window-closure that's in the past disables
// the upload flow. Spec §4/§9 — gates exist independently of payments.
export function isEventOpen(e: EventForGuest, now: number = Date.now()): boolean {
  if (e.status !== "active") return false;
  if (e.uploads_close_at && Date.parse(e.uploads_close_at) <= now) return false;
  if (e.storage_expires_at && Date.parse(e.storage_expires_at) <= now) return false;
  return true;
}

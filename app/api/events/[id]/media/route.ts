import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  loadGalleryPage,
  ownsEvent,
  type MediaStatus,
} from "@/lib/gallery/queries";

// GET /api/events/[id]/media?offset=…&limit=…&uploader=…&status=…
// Host-only, RLS-scoped. Returns one paginated page of the event's
// host-visible (pending + approved) media with short-lived signed URLs.
// FRI-16 / FRI-30 / TECH_SPEC §6 §9.
//
// The signed URLs expire in SIGNED_URL_TTL_SECONDS (300s) — a host who leaves
// the tab open past that will see broken thumbs on refresh, which is the
// intended "leaked URL stales out" trade-off. Bulk signing goes through
// service_role because RLS on storage.objects (0003_storage_rls.sql) only
// grants SELECT to `anon` inside the event-open window, not to authenticated
// hosts.
export const runtime = "nodejs";

// Auth gate: this endpoint reveals per-photo signed URLs. If Next inlined
// caching on it, a second host could receive another host's URLs from cache.
// Force dynamic to be safe.
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // ownsEvent leans on the `own events` RLS policy — a foreign id returns
  // null, indistinguishable from a genuine 404.
  const owned = await ownsEvent(supabase, params.id);
  if (!owned) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }

  const url = new URL(req.url);
  const rawOffset = Number(url.searchParams.get("offset") ?? "0");
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, Math.floor(rawLimit)), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  // Uploader filter: `?uploader=<token>` filters to a specific guest;
  // `?uploader=` (present but empty) filters to anonymous rows. Omitted →
  // whole gallery. Matches the semantic in fetchMediaPage.
  let uploaderToken: string | null | undefined;
  if (url.searchParams.has("uploader")) {
    const raw = url.searchParams.get("uploader") ?? "";
    uploaderToken = raw.length > 0 ? raw : null;
  } else {
    uploaderToken = undefined;
  }

  // Status filter (FRI-30 moderation queue): `?status=pending` narrows to
  // the un-reviewed queue, `?status=approved` to the public roll. Omitted →
  // both. Anything else (including 'rejected' — soft-deleted rows must stay
  // unreachable) is a 400 rather than a silent full-page fallback.
  let status: MediaStatus | undefined;
  const rawStatus = url.searchParams.get("status");
  if (rawStatus !== null) {
    if (rawStatus !== "pending" && rawStatus !== "approved") {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    status = rawStatus;
  }

  try {
    const page = await loadGalleryPage(supabase, params.id, {
      offset,
      limit,
      uploaderToken,
      status,
    });
    return NextResponse.json(page);
  } catch {
    return NextResponse.json(
      { error: "Failed to load gallery." },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ownsEvent } from "@/lib/gallery/queries";

// POST /api/events/[id]/media/delete
// Body: { ids: string[] }
// Returns: { deleted: string[] }
//
// FRI-17 / TECH_SPEC §6 §9. Soft-deletes host-selected media by flipping
// `media.status` from 'active' to 'deleted'. The gallery queries in
// lib/gallery/queries.ts already filter to status='active' — that's the
// single source of truth for what a "deleted" row means downstream (grid,
// counts, uploader summary, and any future ZIP export must reuse that
// filter). Storage objects are left in place for a later hard-delete
// cleanup job; `storage_expires_at` sweeps eventually reclaim them.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Guard against a hostile or buggy client posting a massive id list. A real
// host-driven selection lives in the on-screen page (60 default, 200 max),
// so 500 is generous headroom for a select-visible-across-multiple-pages
// UX without letting a caller pin the DB with a giant IN().
const MAX_IDS_PER_REQUEST = 500;

type Body = { ids?: unknown };

export async function POST(
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
  // null, indistinguishable from a genuine 404. This is the first gate
  // against a cross-host delete (host-A pointing at host-B's event id).
  const owned = await ownsEvent(supabase, params.id);
  if (!owned) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(body.ids)) {
    return NextResponse.json({ error: "`ids` must be an array." }, { status: 400 });
  }
  // Dedupe + drop non-strings. An empty result set is a client bug, not a
  // silent no-op — return 400 so the UI surfaces its own logic error.
  const ids = Array.from(
    new Set(body.ids.filter((v): v is string => typeof v === "string" && v.length > 0)),
  );
  if (ids.length === 0) {
    return NextResponse.json({ error: "No ids to delete." }, { status: 400 });
  }
  if (ids.length > MAX_IDS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Too many ids (max ${MAX_IDS_PER_REQUEST}).` },
      { status: 413 },
    );
  }

  // Defense in depth:
  //   - `event_id = params.id` scopes the update to THIS event, so a host
  //     who owns two events can't accidentally (or maliciously) pass an id
  //     from event B while operating on event A's page.
  //   - `status = 'active'` avoids re-touching already-deleted rows and
  //     keeps the response payload aligned with what actually changed
  //     during THIS request (so the client can update its local list
  //     without wondering whether an id was a no-op).
  //   - RLS on `media` (the `own media` policy in 0001_init.sql, `for all`)
  //     is the ultimate gate: even if the first two filters were absent,
  //     a cross-host update would return zero rows because the policy's
  //     `exists (select 1 from events e where e.host_id = auth.uid())`
  //     check fails for the other host.
  const { data, error } = await supabase
    .from("media")
    .update({ status: "deleted" })
    .eq("event_id", params.id)
    .eq("status", "active")
    .in("id", ids)
    .select("id");

  if (error) {
    return NextResponse.json(
      { error: "Failed to delete media." },
      { status: 500 },
    );
  }

  const deleted = (data ?? []).map((r) => r.id as string);
  return NextResponse.json({ deleted });
}

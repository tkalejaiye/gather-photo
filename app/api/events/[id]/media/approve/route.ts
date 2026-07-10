import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ownsEvent } from "@/lib/gallery/queries";
import { parseIdsPayload, transitionMediaStatus } from "@/lib/gallery/moderation";

// POST /api/events/[id]/media/approve
// Body: { ids: string[], approved: boolean }
// Returns: { updated: string[] }
//
// FRI-30 host moderation, single + bulk:
//   approved: true  → pending  → 'approved' (publish to the shared roll)
//   approved: false → approved → 'pending'  (hide again — pull a shot out
//                     of the public roll without rejecting it)
//
// Only rows currently in the opposite state change; ids already in the
// target state (or rejected) are silently absent from `updated`, so the
// client can reconcile its local list against what actually flipped.
// Rejection goes through the sibling /media/delete route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { ids?: unknown; approved?: unknown };

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
  // null, indistinguishable from a genuine 404. First gate against a
  // cross-host moderation attempt; RLS on `media` is the ultimate one.
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

  if (typeof body.approved !== "boolean") {
    return NextResponse.json(
      { error: "`approved` must be a boolean." },
      { status: 400 },
    );
  }

  const parsed = parseIdsPayload(body.ids);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  const result = await transitionMediaStatus(
    supabase,
    params.id,
    parsed.ids,
    body.approved ? ["pending"] : ["approved"],
    body.approved ? "approved" : "pending",
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: "Failed to update media." },
      { status: 500 },
    );
  }

  return NextResponse.json({ updated: result.ids });
}

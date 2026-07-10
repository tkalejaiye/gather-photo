import type { SupabaseClient } from "@supabase/supabase-js";

// FRI-30 moderation transitions, shared by the approve and delete routes.
// One status machine lives here so the two endpoints can't drift:
//
//   pending  → approved   (approve — single or bulk)
//   approved → pending    (hide again: pull an approved shot out of the
//                          public roll without rejecting it)
//   pending|approved → rejected  (the FRI-17 soft-delete; "reject a pending
//                          photo" and "delete an approved one" are the same
//                          transition, so one endpoint serves both verbs)
//
// 'rejected' is terminal in the UI — no un-reject; the rows sit invisible
// until the storage_expires_at sweep hard-deletes them.

// Guard against a hostile or buggy client posting a massive id list. A real
// host-driven selection lives in the on-screen page (60 default, 200 max),
// so 500 is generous headroom for a select-visible-across-multiple-pages
// UX without letting a caller pin the DB with a giant IN().
export const MAX_IDS_PER_REQUEST = 500;

export type ParsedIds =
  | { ok: true; ids: string[] }
  | { ok: false; error: string; status: 400 | 413 };

// Validate a client-supplied `ids` payload: must be a non-empty array of
// strings, deduped, within the batch cap. An empty result set is a client
// bug, not a silent no-op — 400 so the UI surfaces its own logic error.
export function parseIdsPayload(raw: unknown): ParsedIds {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "`ids` must be an array.", status: 400 };
  }
  const ids = Array.from(
    new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0)),
  );
  if (ids.length === 0) {
    return { ok: false, error: "No ids given.", status: 400 };
  }
  if (ids.length > MAX_IDS_PER_REQUEST) {
    return {
      ok: false,
      error: `Too many ids (max ${MAX_IDS_PER_REQUEST}).`,
      status: 413,
    };
  }
  return { ok: true, ids };
}

// Flip media rows from one of `from` statuses to `to`, returning the ids
// that actually changed. Defense in depth:
//   - `event_id = eventId` scopes the update to THIS event, so a host who
//     owns two events can't pass an id from event B while operating on
//     event A's page.
//   - the `from` filter avoids re-touching rows already in the target (or a
//     terminal) state and keeps the response aligned with what actually
//     changed during THIS request — the client updates its local list
//     without wondering whether an id was a no-op.
//   - RLS on `media` (the `own media` policy in 0001_init.sql, `for all`)
//     is the ultimate gate: even without the filters above, a cross-host
//     update matches zero rows because the policy's host_id check fails.
export async function transitionMediaStatus(
  supabase: SupabaseClient,
  eventId: string,
  ids: string[],
  from: string[],
  to: string,
): Promise<{ ok: true; ids: string[] } | { ok: false }> {
  const { data, error } = await supabase
    .from("media")
    .update({ status: to })
    .eq("event_id", eventId)
    .in("status", from)
    .in("id", ids)
    .select("id");
  if (error) return { ok: false };
  return { ok: true, ids: (data ?? []).map((r) => r.id as string) };
}

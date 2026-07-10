import { describe, it, expect, vi, beforeEach } from "vitest";

// FRI-17 acceptance tests for host moderation / delete, revised by FRI-30.
//   - Auth: unauthenticated → 401; foreign event id → 404 (RLS-shaped).
//   - Body validation: non-array / empty / over-cap payloads → 4xx.
//   - Single + multi-select delete flips status → 'rejected' (FRI-30 renamed
//     the old 'deleted'); works from both 'approved' and 'pending'; the
//     response lists the exact ids that changed this request.
//   - Cross-event scoping: an id belonging to another event the host owns
//     is NOT touched — the endpoint scopes updates by (event_id + ids).
//   - Cross-host: RLS blocks a foreign host from mutating another host's
//     media even if it guessed at the id. Modelled by refusing to update
//     rows whose event isn't in the caller's `ownedEventIds` set.
//   - Downstream: after deletion, the same in-memory model (via
//     loadGalleryPage / fetchTotalCount) omits the row from the gallery
//     grid and total count — which is what the ZIP export reuses.
//
// The mock mirrors tests/gallery.test.ts (media stored in-memory, RLS
// modelled by the events-ownership set + the media row's event pointer).

type MediaStatus = "pending" | "approved" | "rejected";

type MediaRow = {
  id: string;
  event_id: string;
  storage_path: string;
  uploader_token: string | null;
  uploader_name: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  created_at: string;
  status: MediaStatus;
};

const state: {
  user: { id: string } | null;
  // Events the CURRENT caller owns. Everything else is treated as another
  // host's row for RLS-modelling purposes.
  ownedEventIds: Set<string>;
  // Full event → host map, so a foreign-owned event/media row is still
  // findable in the store but is invisible to the caller.
  eventOwners: Map<string, string>;
  media: MediaRow[];
  lastMediaUpdate: {
    eventId?: string;
    statusIn?: string[];
    ids?: string[];
    newStatus?: string;
  };
} = {
  user: null,
  ownedEventIds: new Set<string>(),
  eventOwners: new Map<string, string>(),
  media: [],
  lastMediaUpdate: {},
};

function reset() {
  state.user = null;
  state.ownedEventIds = new Set<string>();
  state.eventOwners = new Map<string, string>();
  state.media = [];
  state.lastMediaUpdate = {};
}

// events.select().eq('id', …).maybeSingle() — used by ownsEvent().
function eventsSelectChain(_cols: string) {
  let filterId: string | null = null;
  const api = {
    eq(col: string, val: string) {
      if (col === "id") filterId = val;
      return api;
    },
    async maybeSingle() {
      if (!filterId || !state.ownedEventIds.has(filterId)) {
        return { data: null, error: null };
      }
      return { data: { id: filterId }, error: null };
    },
  };
  return api;
}

// media.select(…).eq(…)/.in(…).range(…) — used by the gallery grid queries
// after deletion so we can assert the same in-memory rows are hidden.
function mediaSelectChain(_cols: string, options?: { count?: string; head?: boolean }) {
  const filters: {
    eventId?: string;
    statusEq?: string;
    statusIn?: string[];
    uploaderEq?: string;
    uploaderIsNull?: boolean;
  } = {};
  let orderApplied = false;

  const applyFilters = () => {
    return state.media.filter((r) => {
      if (filters.eventId && r.event_id !== filters.eventId) return false;
      if (filters.statusEq && r.status !== filters.statusEq) return false;
      if (filters.statusIn && !filters.statusIn.includes(r.status)) return false;
      if (filters.uploaderEq !== undefined && r.uploader_token !== filters.uploaderEq)
        return false;
      if (filters.uploaderIsNull && r.uploader_token !== null) return false;
      return true;
    });
  };

  const api: Record<string, unknown> = {
    eq(col: string, val: string) {
      if (col === "event_id") filters.eventId = val;
      if (col === "status") filters.statusEq = val;
      if (col === "uploader_token") filters.uploaderEq = val;
      return api;
    },
    in(col: string, vals: string[]) {
      if (col === "status") filters.statusIn = vals;
      return api;
    },
    is(col: string, val: unknown) {
      if (col === "uploader_token" && val === null) filters.uploaderIsNull = true;
      return api;
    },
    order(_col: string, _opts: unknown) {
      orderApplied = true;
      return api;
    },
    async range(from: number, to: number) {
      if (!orderApplied) throw new Error("media query must be ordered");
      const rows = [...applyFilters()].sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1;
        return a.id > b.id ? -1 : 1;
      });
      return { data: rows.slice(from, to + 1), error: null };
    },
    // `head:true` count query used by fetchTotalCount.
    then(resolve: (v: { count: number | null }) => unknown) {
      if (options?.head && options?.count === "exact") {
        return resolve({ count: applyFilters().length });
      }
      return resolve({ count: null });
    },
  };
  return api;
}

// media.update({ status:'rejected' }).eq('event_id',…).in('status',[…]).in('id',[…]).select('id')
function mediaUpdateChain(patch: Record<string, unknown>) {
  const filters: {
    eventId?: string;
    statusIn?: string[];
    ids?: string[];
  } = {};

  const api = {
    eq(col: string, val: string) {
      if (col === "event_id") filters.eventId = val;
      return api;
    },
    in(col: string, values: string[]) {
      if (col === "id") filters.ids = values;
      if (col === "status") filters.statusIn = values;
      return api;
    },
    select(_cols: string) {
      // Capture what the endpoint queried, so tests can assert on shape.
      state.lastMediaUpdate = {
        eventId: filters.eventId,
        statusIn: filters.statusIn,
        ids: filters.ids,
        newStatus: patch.status as string,
      };
      // Model RLS: only rows whose event is owned by the current caller
      // are visible for update. A cross-host attempt (event not in
      // ownedEventIds) matches zero rows even if the id happens to exist.
      const changed: MediaRow[] = [];
      for (const row of state.media) {
        if (!filters.ids?.includes(row.id)) continue;
        if (filters.eventId && row.event_id !== filters.eventId) continue;
        if (filters.statusIn && !filters.statusIn.includes(row.status)) continue;
        // RLS-shaped: caller only sees rows under events they own.
        if (!state.ownedEventIds.has(row.event_id)) continue;
        row.status = (patch.status as MediaRow["status"]) ?? row.status;
        changed.push(row);
      }
      return {
        // The endpoint awaits the query directly (no maybeSingle/single),
        // so expose a thenable that resolves with `{ data, error }`.
        then(resolve: (v: { data: { id: string }[]; error: null }) => unknown) {
          return resolve({
            data: changed.map((r) => ({ id: r.id })),
            error: null,
          });
        },
      };
    },
  };
  return api;
}

const authClient = {
  auth: {
    getUser: async () => ({ data: { user: state.user }, error: null }),
  },
  from(table: string) {
    if (table === "events") return { select: eventsSelectChain };
    if (table === "media") {
      return {
        select: mediaSelectChain,
        update: mediaUpdateChain,
      };
    }
    throw new Error(`unexpected table: ${table}`);
  },
  rpc: async () => ({ data: [], error: null }),
};

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => authClient,
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ getAll: () => [], set: () => {} }),
}));

// Service client is unused by the delete route but IS imported by
// lib/gallery/queries.ts (for signPaths); the gallery-page assertions
// exercise it downstream so we stub it to a no-op signer.
const serviceClient = {
  storage: {
    from(_bucket: string) {
      return {
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((p) => ({ path: p, signedUrl: `https://storage.test/${p}?token=sig` })),
          error: null,
        }),
      };
    },
  },
};
vi.mock("@supabase/supabase-js", () => ({ createClient: () => serviceClient }));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

import { POST as deletePOST } from "@/app/api/events/[id]/media/delete/route";
import { fetchTotalCount, loadGalleryPage } from "@/lib/gallery/queries";

function req(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedMedia(eventId: string, count: number, status: MediaStatus = "approved") {
  for (let i = 0; i < count; i += 1) {
    state.media.push({
      id: `m-${eventId}-${i}`,
      event_id: eventId,
      storage_path: `events/${eventId}/photo-${i.toString().padStart(4, "0")}.jpg`,
      uploader_token: null,
      uploader_name: null,
      width: 2048,
      height: 1536,
      bytes: 250_000,
      created_at: new Date(2026, 5, 1, 0, 0, i).toISOString(),
      status,
    });
  }
}

describe("POST /api/events/[id]/media/delete", () => {
  beforeEach(() => reset());

  it("returns 401 when unauthenticated", async () => {
    const res = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", { ids: ["m-1"] }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the event is not owned by the caller (RLS)", async () => {
    state.user = { id: "host-1" };
    // host-1 doesn't own evt-foreign.
    state.eventOwners.set("evt-foreign", "host-2");
    const res = await deletePOST(
      req("http://localhost/api/events/evt-foreign/media/delete", { ids: ["m-x"] }),
      { params: { id: "evt-foreign" } },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when body is not JSON", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventOwners.set("evt-1", "host-1");
    const bad = new Request("http://localhost/api/events/evt-1/media/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await deletePOST(bad, { params: { id: "evt-1" } });
    expect(res.status).toBe(400);
  });

  it("returns 400 when ids is missing or empty", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventOwners.set("evt-1", "host-1");
    const noArray = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", { ids: "m-1" }),
      { params: { id: "evt-1" } },
    );
    expect(noArray.status).toBe(400);
    const empty = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", { ids: [] }),
      { params: { id: "evt-1" } },
    );
    expect(empty.status).toBe(400);
  });

  it("returns 413 when ids exceeds the batch cap", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventOwners.set("evt-1", "host-1");
    const tooMany = Array.from({ length: 501 }, (_, i) => `m-${i}`);
    const res = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", { ids: tooMany }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(413);
  });

  it("soft-deletes a single item to status='rejected' and returns the deleted id", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventOwners.set("evt-1", "host-1");
    seedMedia("evt-1", 3);

    const res = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", {
        ids: ["m-evt-1-1"],
      }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: string[] };
    expect(body.deleted).toEqual(["m-evt-1-1"]);

    const row = state.media.find((r) => r.id === "m-evt-1-1")!;
    expect(row.status).toBe("rejected");
    // Sanity: the update was scoped to THIS event + host-visible rows.
    expect(state.lastMediaUpdate.eventId).toBe("evt-1");
    expect(state.lastMediaUpdate.statusIn).toEqual(["pending", "approved"]);
    expect(state.lastMediaUpdate.newStatus).toBe("rejected");
  });

  it("soft-deletes multiple items in one request", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventOwners.set("evt-1", "host-1");
    seedMedia("evt-1", 5);

    const res = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", {
        ids: ["m-evt-1-0", "m-evt-1-2", "m-evt-1-4"],
      }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: string[] };
    expect(new Set(body.deleted)).toEqual(
      new Set(["m-evt-1-0", "m-evt-1-2", "m-evt-1-4"]),
    );

    for (const id of ["m-evt-1-0", "m-evt-1-2", "m-evt-1-4"]) {
      expect(state.media.find((r) => r.id === id)!.status).toBe("rejected");
    }
    for (const id of ["m-evt-1-1", "m-evt-1-3"]) {
      expect(state.media.find((r) => r.id === id)!.status).toBe("approved");
    }
  });

  it("rejects a pending item too — deleting from the moderation queue works", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventOwners.set("evt-1", "host-1");
    seedMedia("evt-1", 2, "pending");

    const res = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", {
        ids: ["m-evt-1-0"],
      }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: string[] };
    expect(body.deleted).toEqual(["m-evt-1-0"]);
    expect(state.media.find((r) => r.id === "m-evt-1-0")!.status).toBe("rejected");
    expect(state.media.find((r) => r.id === "m-evt-1-1")!.status).toBe("pending");
  });

  it("does not re-touch an already-rejected row", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventOwners.set("evt-1", "host-1");
    seedMedia("evt-1", 1, "rejected");

    const res = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", {
        ids: ["m-evt-1-0"],
      }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: string[] };
    // Already rejected → not part of what changed THIS request.
    expect(body.deleted).toEqual([]);
  });

  it("ignores an id that belongs to another event the host owns", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.ownedEventIds.add("evt-2");
    state.eventOwners.set("evt-1", "host-1");
    state.eventOwners.set("evt-2", "host-1");
    seedMedia("evt-1", 2);
    seedMedia("evt-2", 2);

    // Pass one id from evt-1 and one from evt-2, but scope the endpoint to
    // evt-1. Only the evt-1 id should flip.
    const res = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", {
        ids: ["m-evt-1-0", "m-evt-2-0"],
      }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: string[] };
    expect(body.deleted).toEqual(["m-evt-1-0"]);
    expect(state.media.find((r) => r.id === "m-evt-2-0")!.status).toBe("approved");
  });

  it("denies a cross-host delete: caller cannot touch another host's media", async () => {
    state.user = { id: "host-1" };
    // host-1 owns evt-1 only.
    state.ownedEventIds.add("evt-1");
    state.eventOwners.set("evt-1", "host-1");
    // evt-2 belongs to host-2 with media inside. host-1 is not in
    // ownedEventIds, so the update-chain RLS mock refuses to touch any
    // of the evt-2 rows even if their ids leak.
    state.eventOwners.set("evt-2", "host-2");
    seedMedia("evt-2", 2);

    // Try the direct attack: point at evt-2 as the event id.
    const asOther = await deletePOST(
      req("http://localhost/api/events/evt-2/media/delete", {
        ids: ["m-evt-2-0"],
      }),
      { params: { id: "evt-2" } },
    );
    expect(asOther.status).toBe(404);

    // Try the smuggle attack: point at the owned event, pass evt-2 ids.
    const smuggle = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", {
        ids: ["m-evt-2-0", "m-evt-2-1"],
      }),
      { params: { id: "evt-1" } },
    );
    expect(smuggle.status).toBe(200);
    const body = (await smuggle.json()) as { deleted: string[] };
    expect(body.deleted).toEqual([]);
    // Cross-check: the target rows are untouched.
    for (const id of ["m-evt-2-0", "m-evt-2-1"]) {
      expect(state.media.find((r) => r.id === id)!.status).toBe("approved");
    }
  });

  it("dedupes duplicate ids in the request body", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventOwners.set("evt-1", "host-1");
    seedMedia("evt-1", 2);

    const res = await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", {
        ids: ["m-evt-1-0", "m-evt-1-0", "m-evt-1-0"],
      }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: string[] };
    expect(body.deleted).toEqual(["m-evt-1-0"]);
    expect(state.lastMediaUpdate.ids).toEqual(["m-evt-1-0"]);
  });

  it("excludes rejected media from the gallery page and total count", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventOwners.set("evt-1", "host-1");
    seedMedia("evt-1", 5);

    const before = await fetchTotalCount(authClient as never, "evt-1");
    expect(before).toBe(5);

    await deletePOST(
      req("http://localhost/api/events/evt-1/media/delete", {
        ids: ["m-evt-1-1", "m-evt-1-3"],
      }),
      { params: { id: "evt-1" } },
    );

    const after = await fetchTotalCount(authClient as never, "evt-1");
    expect(after).toBe(3);

    const page = await loadGalleryPage(authClient as never, "evt-1", {
      offset: 0,
      limit: 60,
    });
    const ids = page.items.map((i) => i.id);
    expect(ids).not.toContain("m-evt-1-1");
    expect(ids).not.toContain("m-evt-1-3");
    expect(ids).toHaveLength(3);
  });
});

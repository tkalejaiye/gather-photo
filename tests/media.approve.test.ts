import { describe, it, expect, vi, beforeEach } from "vitest";

// FRI-30 acceptance tests for the host approve/hide endpoint.
//   - Auth: unauthenticated → 401; foreign event id → 404 (RLS-shaped).
//   - Body validation: missing/non-boolean `approved`, non-array / empty /
//     over-cap `ids` → 4xx.
//   - approve (approved:true) flips pending → approved, single + bulk, and
//     only touches pending rows: already-approved and rejected ids are
//     absent from `updated`.
//   - hide (approved:false) flips approved → pending — the "pull it back
//     out of the public roll" transition — and never resurrects rejected.
//   - Cross-event and cross-host scoping mirror the delete endpoint.
//   - Downstream: approval changes what the approved-only (public) count
//     sees, while the host count stays put.
//
// Mock mirrors tests/media.delete.test.ts (in-memory media store, RLS
// modelled via ownedEventIds).

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
  ownedEventIds: Set<string>;
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
  media: [],
  lastMediaUpdate: {},
};

function reset() {
  state.user = null;
  state.ownedEventIds = new Set<string>();
  state.media = [];
  state.lastMediaUpdate = {};
}

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

function mediaSelectChain(_cols: string, options?: { count?: string; head?: boolean }) {
  const filters: {
    eventId?: string;
    statusEq?: string;
    statusIn?: string[];
  } = {};

  const applyFilters = () =>
    state.media.filter((r) => {
      if (filters.eventId && r.event_id !== filters.eventId) return false;
      if (filters.statusEq && r.status !== filters.statusEq) return false;
      if (filters.statusIn && !filters.statusIn.includes(r.status)) return false;
      return true;
    });

  const api: Record<string, unknown> = {
    eq(col: string, val: string) {
      if (col === "event_id") filters.eventId = val;
      if (col === "status") filters.statusEq = val;
      return api;
    },
    in(col: string, vals: string[]) {
      if (col === "status") filters.statusIn = vals;
      return api;
    },
    then(resolve: (v: { count: number | null }) => unknown) {
      if (options?.head && options?.count === "exact") {
        return resolve({ count: applyFilters().length });
      }
      return resolve({ count: null });
    },
  };
  return api;
}

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
      state.lastMediaUpdate = {
        eventId: filters.eventId,
        statusIn: filters.statusIn,
        ids: filters.ids,
        newStatus: patch.status as string,
      };
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

// Imported transitively via lib/gallery/queries.ts (signPaths); unused here.
const serviceClient = {
  storage: {
    from(_bucket: string) {
      return {
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((p) => ({ path: p, signedUrl: `https://storage.test/${p}` })),
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

import { POST as approvePOST } from "@/app/api/events/[id]/media/approve/route";
import { fetchTotalCount } from "@/lib/gallery/queries";

function req(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedMedia(eventId: string, count: number, status: MediaStatus) {
  for (let i = 0; i < count; i += 1) {
    state.media.push({
      id: `m-${eventId}-${status}-${i}`,
      event_id: eventId,
      storage_path: `events/${eventId}/photo-${status}-${i}.jpg`,
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

function ownEvent(id: string) {
  state.user = { id: "host-1" };
  state.ownedEventIds.add(id);
}

describe("POST /api/events/[id]/media/approve", () => {
  beforeEach(() => reset());

  it("returns 401 when unauthenticated", async () => {
    const res = await approvePOST(
      req("http://localhost/api/events/evt-1/media/approve", {
        ids: ["m-1"],
        approved: true,
      }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the event is not owned by the caller (RLS)", async () => {
    state.user = { id: "host-1" };
    const res = await approvePOST(
      req("http://localhost/api/events/evt-foreign/media/approve", {
        ids: ["m-x"],
        approved: true,
      }),
      { params: { id: "evt-foreign" } },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when `approved` is missing or not a boolean", async () => {
    ownEvent("evt-1");
    for (const approved of [undefined, "true", 1, null]) {
      const res = await approvePOST(
        req("http://localhost/api/events/evt-1/media/approve", {
          ids: ["m-1"],
          approved,
        }),
        { params: { id: "evt-1" } },
      );
      expect(res.status).toBe(400);
    }
  });

  it("validates ids like the delete endpoint (non-array / empty / over cap)", async () => {
    ownEvent("evt-1");
    const notArray = await approvePOST(
      req("http://localhost/api/events/evt-1/media/approve", {
        ids: "m-1",
        approved: true,
      }),
      { params: { id: "evt-1" } },
    );
    expect(notArray.status).toBe(400);

    const empty = await approvePOST(
      req("http://localhost/api/events/evt-1/media/approve", {
        ids: [],
        approved: true,
      }),
      { params: { id: "evt-1" } },
    );
    expect(empty.status).toBe(400);

    const tooMany = await approvePOST(
      req("http://localhost/api/events/evt-1/media/approve", {
        ids: Array.from({ length: 501 }, (_, i) => `m-${i}`),
        approved: true,
      }),
      { params: { id: "evt-1" } },
    );
    expect(tooMany.status).toBe(413);
  });

  it("approves a single pending item", async () => {
    ownEvent("evt-1");
    seedMedia("evt-1", 2, "pending");

    const res = await approvePOST(
      req("http://localhost/api/events/evt-1/media/approve", {
        ids: ["m-evt-1-pending-0"],
        approved: true,
      }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[] };
    expect(body.updated).toEqual(["m-evt-1-pending-0"]);
    expect(state.media.find((r) => r.id === "m-evt-1-pending-0")!.status).toBe(
      "approved",
    );
    expect(state.media.find((r) => r.id === "m-evt-1-pending-1")!.status).toBe(
      "pending",
    );
    // The update only targets pending rows when approving.
    expect(state.lastMediaUpdate.statusIn).toEqual(["pending"]);
    expect(state.lastMediaUpdate.newStatus).toBe("approved");
  });

  it("bulk-approves and skips ids that were not pending", async () => {
    ownEvent("evt-1");
    seedMedia("evt-1", 3, "pending");
    seedMedia("evt-1", 1, "approved");
    seedMedia("evt-1", 1, "rejected");

    const res = await approvePOST(
      req("http://localhost/api/events/evt-1/media/approve", {
        ids: [
          "m-evt-1-pending-0",
          "m-evt-1-pending-2",
          "m-evt-1-approved-0",
          "m-evt-1-rejected-0",
        ],
        approved: true,
      }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[] };
    expect(new Set(body.updated)).toEqual(
      new Set(["m-evt-1-pending-0", "m-evt-1-pending-2"]),
    );
    // A rejected row is never resurrected by approve.
    expect(state.media.find((r) => r.id === "m-evt-1-rejected-0")!.status).toBe(
      "rejected",
    );
  });

  it("hides an approved item (approved:false → pending) without touching rejected", async () => {
    ownEvent("evt-1");
    seedMedia("evt-1", 2, "approved");
    seedMedia("evt-1", 1, "rejected");

    const res = await approvePOST(
      req("http://localhost/api/events/evt-1/media/approve", {
        ids: ["m-evt-1-approved-1", "m-evt-1-rejected-0"],
        approved: false,
      }),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[] };
    expect(body.updated).toEqual(["m-evt-1-approved-1"]);
    expect(state.media.find((r) => r.id === "m-evt-1-approved-1")!.status).toBe(
      "pending",
    );
    expect(state.media.find((r) => r.id === "m-evt-1-rejected-0")!.status).toBe(
      "rejected",
    );
    expect(state.lastMediaUpdate.statusIn).toEqual(["approved"]);
    expect(state.lastMediaUpdate.newStatus).toBe("pending");
  });

  it("scopes updates to the event in the URL", async () => {
    ownEvent("evt-1");
    state.ownedEventIds.add("evt-2");
    seedMedia("evt-1", 1, "pending");
    seedMedia("evt-2", 1, "pending");

    const res = await approvePOST(
      req("http://localhost/api/events/evt-1/media/approve", {
        ids: ["m-evt-1-pending-0", "m-evt-2-pending-0"],
        approved: true,
      }),
      { params: { id: "evt-1" } },
    );
    const body = (await res.json()) as { updated: string[] };
    expect(body.updated).toEqual(["m-evt-1-pending-0"]);
    expect(state.media.find((r) => r.id === "m-evt-2-pending-0")!.status).toBe(
      "pending",
    );
  });

  it("denies a cross-host approve", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    // evt-2 belongs to someone else — not in ownedEventIds.
    seedMedia("evt-2", 1, "pending");

    const direct = await approvePOST(
      req("http://localhost/api/events/evt-2/media/approve", {
        ids: ["m-evt-2-pending-0"],
        approved: true,
      }),
      { params: { id: "evt-2" } },
    );
    expect(direct.status).toBe(404);

    const smuggle = await approvePOST(
      req("http://localhost/api/events/evt-1/media/approve", {
        ids: ["m-evt-2-pending-0"],
        approved: true,
      }),
      { params: { id: "evt-1" } },
    );
    expect(smuggle.status).toBe(200);
    const body = (await smuggle.json()) as { updated: string[] };
    expect(body.updated).toEqual([]);
    expect(state.media.find((r) => r.id === "m-evt-2-pending-0")!.status).toBe(
      "pending",
    );
  });

  it("moves items into the public (approved-only) count on approval", async () => {
    ownEvent("evt-1");
    seedMedia("evt-1", 2, "pending");
    seedMedia("evt-1", 3, "approved");

    // Public surfaces (guest landing pill, FRI-37 gallery) count approved
    // only; the host count covers both.
    expect(await fetchTotalCount(authClient as never, "evt-1", "approved")).toBe(3);
    expect(await fetchTotalCount(authClient as never, "evt-1")).toBe(5);

    await approvePOST(
      req("http://localhost/api/events/evt-1/media/approve", {
        ids: ["m-evt-1-pending-0", "m-evt-1-pending-1"],
        approved: true,
      }),
      { params: { id: "evt-1" } },
    );

    expect(await fetchTotalCount(authClient as never, "evt-1", "approved")).toBe(5);
    expect(await fetchTotalCount(authClient as never, "evt-1", "pending")).toBe(0);
    expect(await fetchTotalCount(authClient as never, "evt-1")).toBe(5);
  });
});

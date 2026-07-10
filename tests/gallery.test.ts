import { describe, it, expect, vi, beforeEach } from "vitest";

// FRI-16 acceptance tests for the host gallery API.
// - Auth: unauthenticated → 401; foreign event id → 404 (RLS-shaped).
// - Correctness: pagination hasMore + nextOffset; uploader filter (specific,
//   anonymous, or no filter) reaches the right Supabase predicate.
// - Signed URLs: minted via bulk createSignedUrls with the spec's short TTL,
//   and rows the signer can't produce a URL for are omitted from the page.
//
// The pattern mirrors tests/uploads.register.test.ts: mock @supabase/ssr
// (auth client) and @supabase/supabase-js (service client used for signing),
// then import the route module. Route auth guards live in the module scope,
// so we mock before import.

type MediaRow = {
  id: string;
  storage_path: string;
  uploader_token: string | null;
  uploader_name: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  created_at: string;
  status: "pending" | "approved" | "rejected";
};

const state: {
  user: { id: string } | null;
  ownedEventIds: Set<string>;
  media: MediaRow[];
  lastMediaQuery: {
    eventId?: string;
    statusEq?: string;
    statusIn?: string[];
    uploaderEq?: string;
    uploaderIsNull?: boolean;
    rangeFrom?: number;
    rangeTo?: number;
  };
  signedTtlSeconds: number | null;
  signedPaths: string[];
  missingObjects: Set<string>;
} = {
  user: null,
  ownedEventIds: new Set<string>(),
  media: [],
  lastMediaQuery: {},
  signedTtlSeconds: null,
  signedPaths: [],
  missingObjects: new Set<string>(),
};

function reset() {
  state.user = null;
  state.ownedEventIds = new Set<string>();
  state.media = [];
  state.lastMediaQuery = {};
  state.signedTtlSeconds = null;
  state.signedPaths = [];
  state.missingObjects = new Set<string>();
}

function eventsSelectChain(_cols: string) {
  let filterId: string | null = null;
  const api = {
    eq(col: string, val: string) {
      if (col === "id") filterId = val;
      return api;
    },
    async maybeSingle() {
      // Model RLS: only rows the user owns are visible. Foreign or unknown
      // ids come back null — the same shape the real client returns.
      if (!filterId || !state.ownedEventIds.has(filterId)) {
        return { data: null, error: null };
      }
      return { data: { id: filterId }, error: null };
    },
  };
  return api;
}

function mediaSelectChain(_cols: string) {
  const filters: {
    eventId?: string;
    statusEq?: string;
    statusIn?: string[];
    uploaderEq?: string;
    uploaderIsNull?: boolean;
  } = {};
  let orderApplied = false;

  const api = {
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
      // Capture the query shape so tests can assert against it.
      state.lastMediaQuery = {
        eventId: filters.eventId,
        statusEq: filters.statusEq,
        statusIn: filters.statusIn,
        uploaderEq: filters.uploaderEq,
        uploaderIsNull: filters.uploaderIsNull,
        rangeFrom: from,
        rangeTo: to,
      };
      if (!orderApplied) {
        // Force an explicit failure if the query forgot to order — the
        // covering index is only useful under a stable order.
        throw new Error("media query must be ordered");
      }
      let rows = state.media.filter(
        (r) => r.storage_path.startsWith(`events/${filters.eventId}/`),
      );
      // FRI-30 status semantics: .eq narrows to one status, .in to a set.
      if (filters.statusEq) rows = rows.filter((r) => r.status === filters.statusEq);
      if (filters.statusIn)
        rows = rows.filter((r) => filters.statusIn!.includes(r.status));
      if (filters.uploaderEq !== undefined) {
        rows = rows.filter((r) => r.uploader_token === filters.uploaderEq);
      } else if (filters.uploaderIsNull) {
        rows = rows.filter((r) => r.uploader_token === null);
      }
      // Newest-first, tie-break by id descending — matches the real ORDER BY.
      rows = [...rows].sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1;
        return a.id > b.id ? -1 : 1;
      });
      const slice = rows.slice(from, to + 1);
      return { data: slice, error: null };
    },
  };
  return api;
}

// The authenticated (RLS-scoped) Supabase client used by createClient() in
// lib/supabase/server.ts.
const authClient = {
  auth: {
    getUser: async () => ({ data: { user: state.user }, error: null }),
  },
  from(table: string) {
    if (table === "events") return { select: eventsSelectChain };
    if (table === "media") return { select: mediaSelectChain };
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

// Service client used by lib/gallery/queries.ts signPaths().
const serviceClient = {
  storage: {
    from(_bucket: string) {
      return {
        createSignedUrls: async (paths: string[], ttl: number) => {
          state.signedTtlSeconds = ttl;
          state.signedPaths = [...paths];
          const data = paths.map((p) =>
            state.missingObjects.has(p)
              ? { path: p, signedUrl: null }
              : { path: p, signedUrl: `https://storage.test/${p}?token=sig` },
          );
          return { data, error: null };
        },
      };
    },
  },
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => serviceClient,
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

import { GET as mediaGET } from "@/app/api/events/[id]/media/route";
import {
  SIGNED_URL_TTL_SECONDS,
  loadGalleryPage,
} from "@/lib/gallery/queries";

function req(url: string): Request {
  return new Request(url);
}

function seedRows(eventId: string, count: number, seed: (i: number) => Partial<MediaRow>) {
  for (let i = 0; i < count; i += 1) {
    const base: MediaRow = {
      id: `m-${eventId}-${i}`,
      storage_path: `events/${eventId}/photo-${i.toString().padStart(4, "0")}.jpg`,
      uploader_token: null,
      uploader_name: null,
      width: 2048,
      height: 1536,
      bytes: 250_000,
      // Ascending created_at so the newest row sorts to index 0 under DESC.
      created_at: new Date(2026, 5, 1, 0, 0, i).toISOString(),
      status: "approved",
    };
    state.media.push({ ...base, ...seed(i) });
  }
}

describe("GET /api/events/[id]/media", () => {
  beforeEach(() => reset());

  it("returns 401 when unauthenticated", async () => {
    const res = await mediaGET(req("http://localhost/api/events/evt-1/media"), {
      params: { id: "evt-1" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the event is not owned by the caller (RLS)", async () => {
    state.user = { id: "host-1" };
    // host-1 doesn't own evt-foreign — RLS returns null → 404.
    const res = await mediaGET(
      req("http://localhost/api/events/evt-foreign/media"),
      { params: { id: "evt-foreign" } },
    );
    expect(res.status).toBe(404);
  });

  it("returns a page of items with signed URLs and hasMore/nextOffset", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 75, () => ({}));
    // Explicit page size so this test is independent of the default.
    const res = await mediaGET(
      req("http://localhost/api/events/evt-1/media?offset=0&limit=60"),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { url: string; id: string; path: string }[];
      hasMore: boolean;
      nextOffset: number | null;
    };
    expect(body.items).toHaveLength(60);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(60);
    for (const item of body.items) {
      expect(item.url).toContain(item.path);
      expect(item.url).toMatch(/token=sig$/);
    }
  });

  it("signs URLs with the short TTL declared by the queries module", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 3, () => ({}));
    await mediaGET(req("http://localhost/api/events/evt-1/media"), {
      params: { id: "evt-1" },
    });
    expect(state.signedTtlSeconds).toBe(SIGNED_URL_TTL_SECONDS);
    // Sanity: TECH_SPEC §9 asks for "short-lived" URLs — hard-cap this at 10
    // minutes so a future edit can't loosen it silently.
    expect(SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(600);
  });

  it("filters to a specific uploader when ?uploader=<token>", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 5, (i) => ({
      uploader_token: i % 2 === 0 ? "guest-a" : "guest-b",
      uploader_name: i % 2 === 0 ? "Ada" : "Bola",
    }));
    const res = await mediaGET(
      req("http://localhost/api/events/evt-1/media?uploader=guest-a"),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { uploaderToken: string | null; uploaderName: string | null }[];
    };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.uploaderToken).toBe("guest-a");
    }
    expect(state.lastMediaQuery.uploaderEq).toBe("guest-a");
    expect(state.lastMediaQuery.uploaderIsNull).toBeUndefined();
  });

  it("filters to anonymous rows when ?uploader= is present with an empty value", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 4, (i) => ({
      uploader_token: i < 2 ? null : "guest-a",
      uploader_name: i < 2 ? null : "Ada",
    }));
    const res = await mediaGET(
      req("http://localhost/api/events/evt-1/media?uploader="),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { uploaderToken: string | null }[];
    };
    for (const item of body.items) {
      expect(item.uploaderToken).toBeNull();
    }
    expect(state.lastMediaQuery.uploaderIsNull).toBe(true);
    expect(state.lastMediaQuery.uploaderEq).toBeUndefined();
  });

  it("omits the uploader filter entirely when the param is missing", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 2, () => ({}));
    await mediaGET(req("http://localhost/api/events/evt-1/media"), {
      params: { id: "evt-1" },
    });
    expect(state.lastMediaQuery.uploaderEq).toBeUndefined();
    expect(state.lastMediaQuery.uploaderIsNull).toBeUndefined();
  });

  it("drops rows whose signed URL is missing (deleted object under the row)", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 3, () => ({}));
    // Second row lost its object; signer returns null for it.
    state.missingObjects.add("events/evt-1/photo-0001.jpg");
    const res = await mediaGET(req("http://localhost/api/events/evt-1/media"), {
      params: { id: "evt-1" },
    });
    const body = (await res.json()) as { items: { path: string }[] };
    const paths = body.items.map((i) => i.path);
    expect(paths).not.toContain("events/evt-1/photo-0001.jpg");
    expect(paths).toHaveLength(2);
  });

  it("clamps ?limit above the safety cap so a client can't request the entire gallery", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 5, () => ({}));
    await mediaGET(
      req("http://localhost/api/events/evt-1/media?limit=100000"),
      { params: { id: "evt-1" } },
    );
    // Range is inclusive; MAX_PAGE_SIZE is 200 → range(0, 200) with +1 look-ahead.
    // We only assert an upper bound: the range span is at most 200 (limit) +1.
    const to = state.lastMediaQuery.rangeTo ?? -1;
    const from = state.lastMediaQuery.rangeFrom ?? -1;
    expect(to - from + 1).toBeLessThanOrEqual(201);
  });

  it("loadGalleryPage returns hasMore=false on the final partial page", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 5, () => ({}));

    // Direct helper call — mirrors what the API route does internally.
    const page = await loadGalleryPage(authClient as never, "evt-1", {
      offset: 0,
      limit: 60,
    });
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  // ---- FRI-30 approval visibility ----------------------------------------

  it("serves pending AND approved (never rejected) by default, with status on each item", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 6, (i) => ({
      status: i < 2 ? "pending" : i < 5 ? "approved" : "rejected",
    }));

    const res = await mediaGET(req("http://localhost/api/events/evt-1/media"), {
      params: { id: "evt-1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; status: string }[] };
    // 2 pending + 3 approved; the rejected row never leaves the DB.
    expect(body.items).toHaveLength(5);
    for (const item of body.items) {
      expect(["pending", "approved"]).toContain(item.status);
    }
    // Host default reaches the DB as an IN over the host-visible pair.
    expect(state.lastMediaQuery.statusIn).toEqual(["pending", "approved"]);
  });

  it("narrows to the moderation queue with ?status=pending", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 4, (i) => ({ status: i % 2 === 0 ? "pending" : "approved" }));

    const res = await mediaGET(
      req("http://localhost/api/events/evt-1/media?status=pending"),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { status: string }[] };
    expect(body.items).toHaveLength(2);
    for (const item of body.items) expect(item.status).toBe("pending");
    // Narrowed status uses .eq so the covering index prefix serves it.
    expect(state.lastMediaQuery.statusEq).toBe("pending");
  });

  it("rejects ?status values outside the host-visible pair", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    seedRows("evt-1", 2, () => ({ status: "rejected" }));

    // 'rejected' must not be reachable through the API — soft-deleted rows
    // stay invisible even to the owning host's client.
    for (const bad of ["rejected", "deleted", "active", "anything"]) {
      const res = await mediaGET(
        req(`http://localhost/api/events/evt-1/media?status=${bad}`),
        { params: { id: "evt-1" } },
      );
      expect(res.status).toBe(400);
    }
  });
});

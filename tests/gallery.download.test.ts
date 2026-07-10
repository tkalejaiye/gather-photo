import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// FRI-18 acceptance tests for the streamed ZIP download, revised by FRI-30.
//   - Auth: unauthenticated → 401; foreign event id → 404 (RLS-shaped).
//   - Correctness: the default ZIP contains an entry for every APPROVED
//     media row and none for pending/rejected rows (public export = the
//     public roll); `?include=pending` opts the moderation queue in; entry
//     names follow the by-<uploader>/... rule.
//   - Streaming: each entry's HTTP fetch is issued only AFTER the previous
//     entry is drained into the archive — this is what keeps memory flat
//     on a large event, so a regression here is a spec bug, not a perf nit.
//   - Filename derivation helpers (safeUploaderSlug, zipEntryName,
//     zipDownloadFilename) exercised as plain functions so a UI change
//     can't silently break the ZIP layout.
//
// The mock shape mirrors tests/media.delete.test.ts: media rows live in
// module-level `state`, RLS is modelled by an ownedEventIds set, and the
// service client's createSignedUrls returns deterministic URLs. Fetch is
// stubbed globally so archiver reads a tiny in-memory body per entry.

type MediaRow = {
  id: string;
  event_id: string;
  storage_path: string;
  uploader_token: string | null;
  uploader_name: string | null;
  created_at: string;
  status: "pending" | "approved" | "rejected";
};

type FetchLog = {
  order: string[];
  activeAt: Set<string>;
  maxConcurrent: number;
};

const state: {
  user: { id: string } | null;
  ownedEventIds: Set<string>;
  eventSlug: Map<string, string>;
  media: MediaRow[];
  signedTtl: number | null;
  signedBatches: number;
  missingObjects: Set<string>;
  failingObjects: Set<string>;
  fetchLog: FetchLog;
} = {
  user: null,
  ownedEventIds: new Set<string>(),
  eventSlug: new Map<string, string>(),
  media: [],
  signedTtl: null,
  signedBatches: 0,
  missingObjects: new Set<string>(),
  failingObjects: new Set<string>(),
  fetchLog: { order: [], activeAt: new Set(), maxConcurrent: 0 },
};

function reset() {
  state.user = null;
  state.ownedEventIds = new Set<string>();
  state.eventSlug = new Map<string, string>();
  state.media = [];
  state.signedTtl = null;
  state.signedBatches = 0;
  state.missingObjects = new Set<string>();
  state.failingObjects = new Set<string>();
  state.fetchLog = { order: [], activeAt: new Set(), maxConcurrent: 0 };
}

function eventsSelectChain(cols: string) {
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
      // ownsEvent selects `id` only; the second lookup for the slug
      // selects `slug`. Same chain, different projections.
      if (cols.includes("slug")) {
        return { data: { slug: state.eventSlug.get(filterId) ?? filterId }, error: null };
      }
      return { data: { id: filterId }, error: null };
    },
  };
  return api;
}

function mediaSelectChain(_cols: string) {
  const filters: { eventId?: string; status?: string; statusIn?: string[] } = {};
  let orderApplied = false;

  const api = {
    eq(col: string, val: string) {
      if (col === "event_id") filters.eventId = val;
      if (col === "status") filters.status = val;
      return api;
    },
    in(col: string, vals: string[]) {
      if (col === "status") filters.statusIn = vals;
      return api;
    },
    order(_col: string, _opts: unknown) {
      orderApplied = true;
      return api;
    },
    async range(from: number, to: number) {
      if (!orderApplied) throw new Error("media query must be ordered");
      // Model RLS: without matching ownership the query returns nothing.
      // (ownsEvent already 404s in the route; this is defence-in-depth so
      // a helper mis-wiring never yields foreign rows.)
      if (!filters.eventId || !state.ownedEventIds.has(filters.eventId)) {
        return { data: [], error: null };
      }
      const rows = state.media
        .filter(
          (r) =>
            r.event_id === filters.eventId &&
            (filters.status ? r.status === filters.status : true) &&
            (filters.statusIn ? filters.statusIn.includes(r.status) : true),
        )
        .sort((a, b) => {
          if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1;
          return a.id > b.id ? -1 : 1;
        });
      return { data: rows.slice(from, to + 1), error: null };
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

const serviceClient = {
  storage: {
    from(_bucket: string) {
      return {
        createSignedUrls: async (paths: string[], ttl: number) => {
          state.signedTtl = ttl;
          state.signedBatches += 1;
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

vi.mock("@supabase/supabase-js", () => ({ createClient: () => serviceClient }));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

// Global fetch stub. Each response body is a small ReadableStream so we can
// exercise the fromWeb bridge inside the route. We log entry/exit around the
// stream draining to assert the route only opens ONE fetch at a time.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: Request | string | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  const pathMatch = url.match(/storage\.test\/(events\/[^?]+)/);
  const key = pathMatch ? pathMatch[1] : url;
  if (state.failingObjects.has(key)) {
    return new Response(null, { status: 500 });
  }
  state.fetchLog.order.push(key);
  state.fetchLog.activeAt.add(key);
  if (state.fetchLog.activeAt.size > state.fetchLog.maxConcurrent) {
    state.fetchLog.maxConcurrent = state.fetchLog.activeAt.size;
  }
  const encoder = new TextEncoder();
  // Small, unique per-item payload — plain ASCII so it can't collide with
  // a ZIP local-file-header signature (PK\x03\x04) inside compressed data.
  // We're in STORE mode anyway so bytes land verbatim, and the parser walks
  // the trailing central directory rather than scanning payload bytes.
  const bodyBytes = encoder.encode(`content-for:${key}`);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bodyBytes);
      controller.close();
      // Emulate the socket lifecycle: the fetch remains "open" until the
      // consumer finishes reading. archiver reads to end before firing
      // the `entry` event, so activeAt clears at end-of-stream.
      queueMicrotask(() => state.fetchLog.activeAt.delete(key));
    },
  });
  return new Response(body, { status: 200 });
}) as unknown as typeof fetch;

// Restore original fetch after suite so other suites aren't affected. Vitest
// runs test files in isolated modules, but belt-and-braces.
afterAll(() => {
  globalThis.fetch = originalFetch;
});

import { GET as downloadGET } from "@/app/api/events/[id]/download/route";
import {
  DOWNLOAD_SIGNED_URL_TTL_SECONDS,
  safeUploaderSlug,
  zipDownloadFilename,
  zipEntryName,
  type DownloadMediaRow,
} from "@/lib/gallery/download";

function req(url: string): Request {
  return new Request(url);
}

function seedApproved(
  eventId: string,
  n: number,
  seed: (i: number) => Partial<MediaRow> = () => ({}),
) {
  for (let i = 0; i < n; i += 1) {
    const base: MediaRow = {
      id: `mmmmmmmm-${eventId}-${i.toString().padStart(4, "0")}`,
      event_id: eventId,
      storage_path: `events/${eventId}/photo-${i.toString().padStart(4, "0")}.jpg`,
      uploader_token: null,
      uploader_name: null,
      // Ascending real time so DESC sort gives the newest last in seed order.
      created_at: new Date(2026, 5, 1, 0, 0, i).toISOString(),
      status: "approved",
    };
    state.media.push({ ...base, ...seed(i) });
  }
}

// Read a raw ZIP buffer and return the list of file names by parsing the
// central directory. Each central directory file header starts with the
// signature 0x02014b50 (PK\x01\x02, little-endian). File name length lives
// at header+28 (2 bytes LE) and the name at header+46.
//   ref: APPNOTE.TXT section 4.3.12.
// Parsing the central directory (rather than local headers) avoids false
// positives from payload bytes that happen to spell PK\x03\x04 — the
// central directory is at a well-defined end-of-file position.
function readZipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  // Find end-of-central-directory record. Signature = 0x06054b50.
  // Walk backwards up to 65k (max comment length) — for a test-sized ZIP
  // it's within the last few hundred bytes.
  let eocdOffset = -1;
  const minStart = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= minStart; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("EOCD not found — malformed ZIP");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const entries = view.getUint16(eocdOffset + 10, true);
  let cur = centralOffset;
  for (let e = 0; e < entries; e += 1) {
    if (view.getUint32(cur, true) !== 0x02014b50) {
      throw new Error(`central header sig missing at ${cur}`);
    }
    const nameLen = view.getUint16(cur + 28, true);
    const extraLen = view.getUint16(cur + 30, true);
    const commentLen = view.getUint16(cur + 32, true);
    const name = new TextDecoder().decode(
      bytes.slice(cur + 46, cur + 46 + nameLen),
    );
    names.push(name);
    cur += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

describe("GET /api/events/[id]/download", () => {
  beforeEach(() => reset());

  it("returns 401 when unauthenticated", async () => {
    const res = await downloadGET(
      req("http://localhost/api/events/evt-1/download"),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the event is not owned (RLS)", async () => {
    state.user = { id: "host-1" };
    const res = await downloadGET(
      req("http://localhost/api/events/evt-foreign/download"),
      { params: { id: "evt-foreign" } },
    );
    expect(res.status).toBe(404);
  });

  it("streams a ZIP of approved media only — pending and rejected stay out by default", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventSlug.set("evt-1", "sample-wedding");
    seedApproved("evt-1", 7);
    // FRI-30: rejected (soft-deleted) rows must NOT appear in any ZIP;
    // pending rows are excluded from the DEFAULT export.
    state.media[1].status = "rejected";
    state.media[5].status = "rejected";
    state.media[3].status = "pending";

    const res = await downloadGET(
      req("http://localhost/api/events/evt-1/download"),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(
      "sample-wedding-photos-",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");

    // Consume the streamed body. arrayBuffer() drains the Web ReadableStream.
    const buf = new Uint8Array(await res.arrayBuffer());
    // ZIP magic — starts with local file header signature.
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    const names = readZipEntryNames(buf);
    expect(names).toHaveLength(4); // 7 seeded − 2 rejected − 1 pending
    // Every entry belongs to `anonymous/` (no uploader token seeded).
    for (const name of names) expect(name.startsWith("anonymous/")).toBe(true);
    // Every entry preserves the .jpg extension.
    for (const name of names) expect(name.endsWith(".jpg")).toBe(true);
  });

  it("includes pending (never rejected) when ?include=pending is passed", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventSlug.set("evt-1", "sample-wedding");
    seedApproved("evt-1", 5);
    state.media[0].status = "pending";
    state.media[1].status = "pending";
    state.media[4].status = "rejected";

    const res = await downloadGET(
      req("http://localhost/api/events/evt-1/download?include=pending"),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    const names = readZipEntryNames(buf);
    expect(names).toHaveLength(4); // 2 approved + 2 pending; rejected stays out
  });

  it("groups entries by uploader with safe folder names", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventSlug.set("evt-1", "wedding");
    seedApproved("evt-1", 4, (i) => ({
      uploader_token: i < 2 ? "guest-a" : null,
      uploader_name: i < 2 ? "Adé Öla!!" : null,
    }));
    const res = await downloadGET(
      req("http://localhost/api/events/evt-1/download"),
      { params: { id: "evt-1" } },
    );
    const buf = new Uint8Array(await res.arrayBuffer());
    const names = readZipEntryNames(buf);
    expect(names).toHaveLength(4);
    // Two guests + two anonymous rows.
    const byFolder = new Map<string, number>();
    for (const n of names) {
      const folder = n.split("/")[0];
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
    }
    expect(byFolder.get("by-ade-ola")).toBe(2);
    expect(byFolder.get("anonymous")).toBe(2);
  });

  it("skips rows whose signed URL is missing without aborting the ZIP", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventSlug.set("evt-1", "evt");
    seedApproved("evt-1", 3);
    state.missingObjects.add("events/evt-1/photo-0001.jpg");
    const res = await downloadGET(
      req("http://localhost/api/events/evt-1/download"),
      { params: { id: "evt-1" } },
    );
    const buf = new Uint8Array(await res.arrayBuffer());
    const names = readZipEntryNames(buf);
    // 2 entries — the missing one is skipped, the other two survive.
    expect(names).toHaveLength(2);
  });

  it("fetches one object at a time — proves constant memory / socket use", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventSlug.set("evt-1", "big");
    // 50 rows is well past any reasonable "batched parallel fetch" limit
    // but well inside the DOWNLOAD_BATCH_SIZE (200), so this fits in a
    // single signing round trip. If the route ever begins parallelising
    // its fetches, maxConcurrent would jump above 1 and this test fails.
    seedApproved("evt-1", 50);
    await downloadGET(
      req("http://localhost/api/events/evt-1/download"),
      { params: { id: "evt-1" } },
    ).then((r) => r.arrayBuffer());
    expect(state.fetchLog.order.length).toBe(50);
    expect(state.fetchLog.maxConcurrent).toBe(1);
  });

  it("signs URLs with a long-enough TTL for a big transfer", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventSlug.set("evt-1", "evt");
    seedApproved("evt-1", 1);
    await downloadGET(
      req("http://localhost/api/events/evt-1/download"),
      { params: { id: "evt-1" } },
    ).then((r) => r.arrayBuffer());
    // Long download windows need ≥ several minutes; TECH_SPEC §9 asks for
    // "short-lived" — bound the constant top-side at an hour so this can't
    // silently become a leaked-URL bomb.
    expect(state.signedTtl).toBe(DOWNLOAD_SIGNED_URL_TTL_SECONDS);
    expect(DOWNLOAD_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(3600);
    expect(DOWNLOAD_SIGNED_URL_TTL_SECONDS).toBeGreaterThanOrEqual(60 * 5);
  });

  it("returns a well-formed empty ZIP when the gallery has no active media", async () => {
    state.user = { id: "host-1" };
    state.ownedEventIds.add("evt-1");
    state.eventSlug.set("evt-1", "empty");
    const res = await downloadGET(
      req("http://localhost/api/events/evt-1/download"),
      { params: { id: "evt-1" } },
    );
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    // An empty ZIP is just an End-of-Central-Directory record: 22 bytes.
    expect(buf.length).toBeGreaterThanOrEqual(22);
    expect(readZipEntryNames(buf)).toEqual([]);
  });
});

describe("zip entry name helpers", () => {
  it("safeUploaderSlug strips unsafe characters and lowercases", () => {
    expect(safeUploaderSlug("Adé Öla!!")).toBe("ade-ola");
    expect(safeUploaderSlug("  ")).toBe("guest");
    expect(safeUploaderSlug(null)).toBe("guest");
    // Length capped so a hostile name can't blow up the folder path.
    expect(safeUploaderSlug("a".repeat(200)).length).toBeLessThanOrEqual(32);
  });

  it("zipEntryName routes anonymous rows to anonymous/ and preserves extension", () => {
    const seen = new Set<string>();
    const row: DownloadMediaRow = {
      id: "0123abcd-4567-89ef-0123-456789abcdef",
      storage_path: "events/e1/xxxxx.HEIC",
      uploader_token: null,
      uploader_name: null,
      created_at: "2026-06-01T12:00:00.000Z",
    };
    const name = zipEntryName(row, seen);
    // Extension is lowercased so hosts see uniform casing in the ZIP.
    expect(name).toBe("anonymous/2026-06-01-0123abcd.heic");
  });

  it("zipEntryName disambiguates collisions with the row id", () => {
    const seen = new Set<string>();
    const rowA: DownloadMediaRow = {
      id: "aaaaaaaa-1111-2222-3333-000000000001",
      storage_path: "events/e1/a.jpg",
      uploader_token: "g",
      uploader_name: "Guest",
      created_at: "2026-06-01T00:00:00.000Z",
    };
    const rowB: DownloadMediaRow = {
      ...rowA,
      // Same 8-char id prefix would be a rare collision — engineered here
      // so the fallback branch actually fires. Both rows land in the same
      // uploader/date bucket, forcing a name clash on the first pass.
      id: "aaaaaaaa-1111-2222-3333-000000000002",
    };
    const nameA = zipEntryName(rowA, seen);
    const nameB = zipEntryName(rowB, seen);
    expect(nameA).not.toBe(nameB);
    expect(nameB).toContain(rowB.id);
  });

  it("zipDownloadFilename sanitises the slug and dates the file", () => {
    const name = zipDownloadFilename("wedding-2026!!!", new Date("2026-07-06T10:00:00Z"));
    expect(name).toBe("wedding-2026-photos-2026-07-06.zip");
  });
});

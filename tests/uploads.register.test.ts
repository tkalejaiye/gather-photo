import { describe, it, expect, vi, beforeEach } from "vitest";

// Acceptance-test the server-validated register path. Goal: a guest can only
// register a media row against an active, unexpired event — closed, expired,
// and unknown events are rejected. Mirrors the spec §9 requirement.

type EventRow = {
  id: string;
  slug: string;
  name: string;
  event_date: string | null;
  pin: string | null;
  status: string;
  uploads_close_at: string | null;
  storage_expires_at: string | null;
};

const events: EventRow[] = [];
const inserted: Record<string, unknown>[] = [];
/**
 * In-memory `media` rows. Modelled well enough to enforce the (event_id,
 * content_hash) unique index and to serve the follow-up `select+eq+eq+
 * maybeSingle` lookup the register route does on 23505.
 */
type MediaRow = {
  id: string;
  event_id: string;
  content_hash: string;
  storage_path: string;
  uploader_token: string;
  uploader_name: string | null;
  kind: string;
  bytes: number;
  width: number | null;
  height: number | null;
};
const mediaRows: MediaRow[] = [];
const removed: string[] = [];
const cookieStore = new Map<string, string>();
let storageHasObject = true;
// `getEventPinSecret` reads `events.pin` directly via the select chain
// implemented above; the same fake row backs it. We stub the PIN cookie path
// by writing the cookie value the server expects (sha256(slug:pin)).
import { createHash } from "node:crypto";
function expectedPinCookie(slug: string, pin: string): string {
  return createHash("sha256").update(`${slug}:${pin}`).digest("hex");
}

function eventsTable() {
  return {
    select(cols: string) {
      let filterSlug: string | null = null;
      const api = {
        eq(col: string, val: string) {
          if (col === "slug") filterSlug = val;
          return api;
        },
        async maybeSingle() {
          const found = events.find((e) => e.slug === filterSlug);
          if (!found) return { data: null, error: null };
          // `getEventPinSecret` selects only `pin`; everything else needs the
          // full row.
          const data = cols.trim() === "pin" ? { pin: found.pin } : found;
          return { data, error: null };
        },
      };
      return api;
    },
  };
}

function mediaTable() {
  return {
    insert(row: Record<string, unknown>) {
      // Enforce the media_event_hash_uniq unique index — same key → 23505.
      const eventId = row.event_id as string;
      const hash = row.content_hash as string;
      const clash = mediaRows.find(
        (r) => r.event_id === eventId && r.content_hash === hash,
      );
      if (clash) {
        return {
          select: () => ({
            single: async () => ({
              data: null,
              error: { code: "23505", message: "unique_violation" },
            }),
          }),
        };
      }
      const id = `media-${mediaRows.length + 1}`;
      mediaRows.push({
        id,
        event_id: eventId,
        content_hash: hash,
        storage_path: row.storage_path as string,
        uploader_token: row.uploader_token as string,
        uploader_name: (row.uploader_name as string | null) ?? null,
        kind: row.kind as string,
        bytes: row.bytes as number,
        width: (row.width as number | null) ?? null,
        height: (row.height as number | null) ?? null,
      });
      inserted.push(row);
      return {
        select: () => ({
          single: async () => ({ data: { id }, error: null }),
        }),
      };
    },
    select(_cols: string) {
      const filters: Partial<Record<keyof MediaRow, string>> = {};
      const api = {
        eq(col: keyof MediaRow, val: string) {
          filters[col] = val;
          return api;
        },
        async maybeSingle() {
          const row = mediaRows.find((r) =>
            Object.entries(filters).every(
              ([k, v]) => r[k as keyof MediaRow] === v,
            ),
          );
          return { data: row ?? null, error: null };
        },
      };
      return api;
    },
  };
}

const fakeStorage = {
  from(_bucket: string) {
    return {
      createSignedUploadUrl: async (path: string) => ({
        data: { signedUrl: `https://storage.test/${path}?token=t`, token: "t", path },
        error: null,
      }),
      createSignedUrl: async (path: string, _ttl: number) => {
        if (!storageHasObject) return { data: null, error: { message: "not found" } };
        return { data: { signedUrl: `https://storage.test/${path}?ttl` }, error: null };
      },
      remove: async (paths: string[]) => {
        for (const p of paths) removed.push(p);
        return { data: paths.map((p) => ({ name: p })), error: null };
      },
    };
  },
};

const fakeServiceClient = {
  from: (t: string) => (t === "events" ? eventsTable() : mediaTable()),
  storage: fakeStorage,
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fakeServiceClient,
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined,
    set: (name: string, value: string) => {
      cookieStore.set(name, value);
    },
  }),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { POST as registerPOST } from "@/app/api/uploads/register/route";
import { POST as signPOST } from "@/app/api/uploads/sign/route";

function reqWith(body: unknown): Request {
  return new Request("http://localhost/api/uploads/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseBody = (overrides: Partial<{ slug: string; path: string }> = {}) => ({
  slug: overrides.slug ?? "active-event-1",
  path: overrides.path ?? "events/evt-active/abc.jpg",
  bytes: 1024,
  width: 100,
  height: 100,
  contentHash: "deadbeef",
  uploaderToken: "guest-token",
  uploaderName: "Ada",
});

describe("/api/uploads/register", () => {
  beforeEach(() => {
    events.length = 0;
    inserted.length = 0;
    mediaRows.length = 0;
    removed.length = 0;
    cookieStore.clear();
    storageHasObject = true;
    events.push(
      {
        id: "evt-active",
        slug: "active-event-1",
        name: "Wedding",
        event_date: null,
        pin: null,
        status: "active",
        uploads_close_at: null,
        storage_expires_at: null,
      },
      {
        id: "evt-draft",
        slug: "draft-event-1",
        name: "Draft",
        event_date: null,
        pin: null,
        status: "draft",
        uploads_close_at: null,
        storage_expires_at: null,
      },
      {
        id: "evt-expired",
        slug: "expired-event-1",
        name: "Expired",
        event_date: null,
        pin: null,
        status: "active",
        uploads_close_at: "2000-01-01T00:00:00.000Z",
        storage_expires_at: null,
      },
      {
        id: "evt-pin",
        slug: "pin-event-1",
        name: "PINned",
        event_date: null,
        pin: "2468",
        status: "active",
        uploads_close_at: null,
        storage_expires_at: null,
      },
    );
  });

  it("inserts a media row for an active event", async () => {
    const res = await registerPOST(reqWith(baseBody()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mediaId: string; duplicate: boolean };
    expect(body.mediaId).toBeTruthy();
    expect(body.duplicate).toBe(false);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      event_id: "evt-active",
      storage_path: "events/evt-active/abc.jpg",
      uploader_token: "guest-token",
      uploader_name: "Ada",
      content_hash: "deadbeef",
      kind: "photo",
    });
  });

  it("rejects an unknown slug with 404", async () => {
    const res = await registerPOST(reqWith(baseBody({ slug: "no-such-slug" })));
    expect(res.status).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it("rejects an inactive (draft) event with 404", async () => {
    const res = await registerPOST(
      reqWith(baseBody({ slug: "draft-event-1", path: "events/evt-draft/abc.jpg" })),
    );
    expect(res.status).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it("rejects an expired event with 404", async () => {
    const res = await registerPOST(
      reqWith(baseBody({ slug: "expired-event-1", path: "events/evt-expired/abc.jpg" })),
    );
    expect(res.status).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it("rejects a path that does not belong to the slug's event", async () => {
    const res = await registerPOST(
      reqWith(baseBody({ slug: "active-event-1", path: "events/evt-other/abc.jpg" })),
    );
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it("rejects when the storage object is missing", async () => {
    storageHasObject = false;
    const res = await registerPOST(reqWith(baseBody()));
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it("rejects a path containing traversal segments", async () => {
    const res = await registerPOST(
      reqWith(baseBody({ path: "events/evt-active/../other.jpg" })),
    );
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it("requires a valid PIN cookie when the event has a PIN", async () => {
    const res = await registerPOST(
      reqWith(baseBody({ slug: "pin-event-1", path: "events/evt-pin/abc.jpg" })),
    );
    expect(res.status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  it("accepts a valid PIN cookie", async () => {
    cookieStore.set("gp_pin_pin-event-1", expectedPinCookie("pin-event-1", "2468"));
    const res = await registerPOST(
      reqWith(baseBody({ slug: "pin-event-1", path: "events/evt-pin/abc.jpg" })),
    );
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
  });

  // 23505 idempotency — the FRI-13 resumable path fires `register` twice when
  // the first response is eaten by a dropped connection AFTER the row was
  // inserted. The queue row pins one storage path across retries, so the
  // second register targets the SAME path — removing the object here would
  // break the row inserted by the first call.
  it("is idempotent on a same-path retry: returns existing mediaId, does not remove the object", async () => {
    const body = baseBody();
    const first = await registerPOST(reqWith(body));
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { mediaId: string; duplicate: boolean };
    expect(firstJson.duplicate).toBe(false);
    expect(mediaRows).toHaveLength(1);

    // Retry with the identical body — models the second drain after the
    // uploader marked the item failed on a lost response.
    const second = await registerPOST(reqWith(body));
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { mediaId: string; duplicate: boolean };
    expect(secondJson.duplicate).toBe(true);
    // Same id as the first call — callers can attribute the media without
    // knowing whether it was fresh or a retry.
    expect(secondJson.mediaId).toBe(firstJson.mediaId);
    // Critical: the storage object must NOT be removed on a same-path retry.
    // Otherwise the row inserted by the first call points at a dead object.
    expect(removed).toEqual([]);
    // The insert() call was attempted a second time but the unique index
    // rejected it — one row survives.
    expect(mediaRows).toHaveLength(1);
  });

  it("orphans the object on a different-path collision (same guest re-picks a photo)", async () => {
    // First insert: fresh path A.
    const first = await registerPOST(
      reqWith(baseBody({ path: "events/evt-active/aaa.jpg" })),
    );
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { mediaId: string };

    // Second insert: same content_hash, DIFFERENT path (FRI-11 direct-upload
    // assigns a fresh UUID per attempt). The existing row still points at
    // path A, so path B is a freshly-uploaded orphan that should be removed.
    const second = await registerPOST(
      reqWith(baseBody({ path: "events/evt-active/bbb.jpg" })),
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { mediaId: string; duplicate: boolean };
    expect(secondJson.duplicate).toBe(true);
    // Still returns the existing mediaId (matches the same-path retry).
    expect(secondJson.mediaId).toBe(firstJson.mediaId);
    // The orphan at path B was cleaned up.
    expect(removed).toEqual(["events/evt-active/bbb.jpg"]);
    // First row survives untouched.
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0].storage_path).toBe("events/evt-active/aaa.jpg");
  });
});

describe("/api/uploads/sign", () => {
  beforeEach(() => {
    events.length = 0;
    cookieStore.clear();
    events.push(
      {
        id: "evt-active",
        slug: "active-event-1",
        name: "Wedding",
        event_date: null,
        pin: null,
        status: "active",
        uploads_close_at: null,
        storage_expires_at: null,
      },
      {
        id: "evt-pin",
        slug: "pin-event-1",
        name: "PINned",
        event_date: null,
        pin: "2468",
        status: "active",
        uploads_close_at: null,
        storage_expires_at: null,
      },
    );
  });

  function signReq(body: unknown): Request {
    return new Request("http://localhost/api/uploads/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns a signed upload URL for an active event", async () => {
    const res = await signPOST(
      signReq({ slug: "active-event-1", contentType: "image/jpeg" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signedUrl: string; path: string; eventId: string };
    expect(body.signedUrl).toMatch(/^https:\/\/storage\.test\//);
    expect(body.path.startsWith("events/evt-active/")).toBe(true);
    expect(body.path.endsWith(".jpg")).toBe(true);
    expect(body.eventId).toBe("evt-active");
  });

  it("rejects unknown slugs", async () => {
    const res = await signPOST(
      signReq({ slug: "no-such-slug", contentType: "image/jpeg" }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects non-image content types", async () => {
    const res = await signPOST(
      signReq({ slug: "active-event-1", contentType: "application/zip" }),
    );
    expect(res.status).toBe(415);
  });

  it("requires a valid PIN cookie when the event has a PIN", async () => {
    const res = await signPOST(
      signReq({ slug: "pin-event-1", contentType: "image/jpeg" }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts an active event when the PIN cookie is set", async () => {
    cookieStore.set("gp_pin_pin-event-1", expectedPinCookie("pin-event-1", "2468"));
    const res = await signPOST(
      signReq({ slug: "pin-event-1", contentType: "image/jpeg" }),
    );
    expect(res.status).toBe(200);
  });
});

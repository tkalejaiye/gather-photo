import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Tiny in-memory stand-in for the `events` table. Both the server (auth)
// client and the service-role client read/write here, so the create →
// open guest page round trip exercises real code paths.
type EventRow = {
  id: string;
  host_id: string;
  name: string;
  slug: string;
  pin: string | null;
  event_date: string | null;
  status: string;
};
const events: EventRow[] = [];
let nextId = 1;
let currentUserId: string | null = "host-1";
const cookieStore = new Map<string, string>();

function eventsTable() {
  return {
    insert(row: Omit<EventRow, "id">) {
      const e: EventRow = { id: `evt-${nextId++}`, ...row };
      events.push(e);
      return {
        select: (_: string) => ({
          single: async () => ({ data: { id: e.id, slug: e.slug }, error: null }),
        }),
      };
    },
    select(_: string) {
      let filterSlug: string | null = null;
      const api = {
        eq(col: string, val: string) {
          if (col === "slug") filterSlug = val;
          return api;
        },
        async maybeSingle() {
          const found = events.find((e) => e.slug === filterSlug);
          return { data: found ?? null, error: null };
        },
      };
      return api;
    },
  };
}

function profilesTable() {
  return { upsert: async () => ({ error: null }) };
}

// Landing pill count (FRI-34): the open guest page runs one head-only COUNT
// on `media` via the service client. Awaitable chain resolving zero rows.
function mediaTable() {
  const api = {
    select: (..._args: unknown[]) => api,
    eq: (..._args: unknown[]) => api,
    then(resolve: (value: { count: number; error: null }) => void) {
      resolve({ count: 0, error: null });
    },
  };
  return api;
}

const fakeAuthClient = {
  auth: {
    getUser: async () => ({
      data: { user: currentUserId ? { id: currentUserId } : null },
    }),
  },
  from: (t: string) => (t === "events" ? eventsTable() : profilesTable()),
};

const fakeServiceClient = {
  from: (t: string) =>
    t === "events" ? eventsTable() : t === "media" ? mediaTable() : profilesTable(),
};

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => fakeAuthClient,
}));

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

class RedirectError extends Error {
  constructor(public location: string) {
    super(`REDIRECT:${location}`);
  }
}
class NotFoundError extends Error {
  constructor() {
    super("NOT_FOUND");
  }
}

vi.mock("next/navigation", () => ({
  redirect: (loc: string) => {
    throw new RedirectError(loc);
  },
  notFound: () => {
    throw new NotFoundError();
  },
}));

// Stub the service-role env vars before the service module is imported.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.NEXT_PUBLIC_APP_URL = "https://gather.test";

// Import AFTER mocks are registered so the modules pick up the fakes.
import { createEvent } from "@/lib/events/actions";
import { getEventBySlug } from "@/lib/events/lookup";
import GuestUploadPage from "@/app/e/[slug]/page";

describe("create → open round trip", () => {
  beforeEach(() => {
    events.length = 0;
    nextId = 1;
    currentUserId = "host-1";
    cookieStore.clear();
  });

  it("persists an unguessable slug and resolves it on the guest page", async () => {
    const res = await createEvent({ name: "Tunde & Amaka" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.slug).toMatch(/^[a-z0-9]{14}$/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "Tunde & Amaka",
      slug: res.slug,
      status: "active",
      pin: null,
    });

    const found = await getEventBySlug(res.slug);
    expect(found?.id).toBe(res.id);

    const tree = await GuestUploadPage({
      params: { slug: res.slug },
      searchParams: {},
    });
    const html = renderToStaticMarkup(tree);
    // Daylight landing (FRI-34) renders server-side: uppercase hero (the
    // accent span splits the name), live eyebrow, real shots count, and the
    // primary CTA. Camera/library inputs moved to the client-side picker
    // screen, so they are no longer part of the SSR shell.
    expect(html).toContain("Tunde &amp;");
    expect(html).toContain("Amaka");
    expect(html).toContain("ROLL · LIVE");
    expect(html).toContain("0 SHOTS IN THE ROLL");
    expect(html).toContain("Add your shots");
  });

  it("404s on an unknown slug", async () => {
    let caught: unknown;
    try {
      await GuestUploadPage({
        params: { slug: "abcdefghjkmnpq" },
        searchParams: {},
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
  });

  it("requires the PIN when one is set", async () => {
    const res = await createEvent({ name: "Private bash", pin: "2468" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const tree = await GuestUploadPage({
      params: { slug: res.slug },
      searchParams: {},
    });
    // Until the cookie is set, the upload UI is replaced by the PIN form.
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("PIN-protected");
    expect(html).not.toContain("Share your photos");
  });

  it("rejects an unauthenticated host", async () => {
    currentUserId = null;
    const res = await createEvent({ name: "ghost" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.toLowerCase()).toContain("signed in");
  });

  it("rejects a malformed PIN", async () => {
    const res = await createEvent({ name: "x", pin: "abc" });
    expect(res.ok).toBe(false);
  });

  it("renders an 'event has ended' page when the event is closed", async () => {
    // Push a closed event directly — mirrors what an expired row would look
    // like in the DB. Guests should see the ended message, not a 404.
    events.push({
      id: "evt-closed",
      host_id: "host-1",
      name: "Yesterday's party",
      slug: "abcdefgh234567",
      pin: null,
      event_date: null,
      status: "expired",
    });
    const tree = await GuestUploadPage({
      params: { slug: "abcdefgh234567" },
      searchParams: {},
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Yesterday&#x27;s party");
    expect(html).toContain("This event has ended");
    expect(html).not.toContain("Share your photos");
  });
});

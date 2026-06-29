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

const fakeAuthClient = {
  auth: {
    getUser: async () => ({
      data: { user: currentUserId ? { id: currentUserId } : null },
    }),
  },
  from: (t: string) => (t === "events" ? eventsTable() : profilesTable()),
};

const fakeServiceClient = {
  from: (t: string) => (t === "events" ? eventsTable() : profilesTable()),
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
    expect(html).toContain("Tunde &amp; Amaka");
    expect(html).toContain("Share your photos");
    // FRI-9 shell: name input + camera + multi-select affordances render
    // server-side so the guest sees them before client JS hydrates.
    expect(html).toContain("Your name (optional)");
    expect(html).toContain("Take photo");
    expect(html).toContain("Choose photos");
    expect(html).toMatch(/capture="environment"/);
    expect(html).toMatch(/<input[^>]*\bmultiple\b/);
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
});

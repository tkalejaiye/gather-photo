import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// FRI-36 — Daylight host dashboard structure: events list (/dashboard),
// create form (/dashboard/new) and Roll Control (/dashboard/events/[id]).

const getUser = vi.fn();
const fromMock = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser }, from: fromMock }),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: () => {},
  }),
}));

class RedirectError extends Error {
  constructor(public location: string) {
    super(`REDIRECT:${location}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new RedirectError(location);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/auth/ensureProfile", () => ({
  ensureProfile: vi.fn().mockResolvedValue(undefined),
}));

// The gallery reads and the QR render are exercised by their own suites
// (gallery.test.ts, gallery.download.test.ts); here they're stubbed so the
// page test stays about page structure.
vi.mock("@/lib/gallery/queries", () => ({
  DEFAULT_PAGE_SIZE: 60,
  loadGalleryPage: vi.fn().mockResolvedValue({
    items: [
      {
        id: "m-1",
        url: "https://signed.example/m-1.jpg",
        path: "e-1/m-1.jpg",
        uploaderToken: "t-priya",
        uploaderName: "Priya",
        width: 1000,
        height: 1000,
        bytes: 12345,
        createdAt: "2026-07-05T20:00:00Z",
        status: "approved",
      },
      {
        id: "m-2",
        url: "https://signed.example/m-2.jpg",
        path: "e-1/m-2.jpg",
        uploaderToken: null,
        uploaderName: null,
        width: 1000,
        height: 1000,
        bytes: 12345,
        createdAt: "2026-07-05T21:00:00Z",
        status: "pending",
      },
    ],
    hasMore: false,
    nextOffset: null,
  }),
  // FRI-30: the page asks for the host total (no status) AND the pending
  // count. One awaiting-approval shot matches the m-2 item above.
  fetchTotalCount: vi
    .fn()
    .mockImplementation((_supabase: unknown, _eventId: string, status?: string) =>
      Promise.resolve(status === "pending" ? 1 : 132),
    ),
  fetchUploaderSummary: vi.fn().mockResolvedValue([
    { token: "t-priya", displayName: "Priya", count: 100 },
    { token: "", displayName: null, count: 32 },
  ]),
}));

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,QRSTUB"),
  },
}));

import DashboardPage from "@/app/dashboard/page";
import NewEventPage from "@/app/dashboard/new/page";
import { CreateEventForm } from "@/app/dashboard/new/CreateEventForm";
import EventDetailPage from "@/app/dashboard/events/[id]/page";

const HOST = { id: "u-1", email: "host@example.com" };

function eventsListChain(rows: unknown[]) {
  return {
    select: () => ({
      order: async () => ({ data: rows }),
    }),
  };
}

function eventDetailChain(row: unknown) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: row }),
      }),
    }),
  };
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: HOST } });
  fromMock.mockReset();
});

describe("/dashboard events list", () => {
  it("renders Daylight cards with status chips and the create CTA", async () => {
    fromMock.mockImplementation(() =>
      eventsListChain([
        {
          id: "e-1",
          name: "Lake House '26",
          slug: "lake26",
          event_date: "2026-07-04",
          status: "active",
          created_at: "2026-06-01T00:00:00Z",
        },
        {
          id: "e-2",
          name: "Tunde & Amaka",
          slug: "ta26",
          event_date: null,
          status: "draft",
          created_at: "2026-06-02T00:00:00Z",
        },
      ]),
    );
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("GATHER");
    expect(html).toContain("host@example.com");
    expect(html).toContain("Sign out");
    expect(html).toContain("Lake House");
    expect(html).toContain("Jul 4, 2026");
    expect(html).toContain("/e/lake26");
    expect(html).toContain("Live");
    expect(html).toContain("Draft");
    expect(html).toContain("/dashboard/new");
    expect(html).toContain("/dashboard/events/e-1");
  });

  it("renders the empty state when the host has no events", async () => {
    fromMock.mockImplementation(() => eventsListChain([]));
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("Create your first event");
  });

  it("redirects signed-out visitors to /sign-in", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    let caught: unknown;
    try {
      await DashboardPage();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RedirectError);
    expect((caught as RedirectError).location).toBe("/sign-in");
  });
});

describe("/dashboard/new create form", () => {
  it("renders the live preview, PIN field, and no cover picker", async () => {
    const page = await NewEventPage({ searchParams: {} });
    const html = renderToStaticMarkup(page);
    expect(html).toContain("NEW EVENT");
    expect(html).toContain("Create your event");
    // Live preview card falls back to a placeholder name before typing.
    expect(html).toContain("Your event");
    expect(html).toContain("GATHER.PHOTO");
    // PIN stays (PRD §7); the mock's cover picker is dropped (FRI-29).
    expect(html).toContain("PIN (optional, 4–8 digits)");
    expect(html).not.toContain("Cover");
    expect(html).toContain("Date (optional)");
  });

  it("disables the submit until a name is present and surfaces errors", () => {
    const html = renderToStaticMarkup(
      <CreateEventForm error="PIN must be 4–8 digits." />,
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Create event/);
    expect(html).toContain("PIN must be 4–8 digits.");
  });
});

describe("/dashboard/events/[id] Roll Control", () => {
  const liveEvent = {
    id: "e-1",
    name: "Lake House '26",
    slug: "lake26",
    pin: null,
    event_date: "2026-07-04",
    status: "active",
    uploads_close_at: "2026-07-08T18:00:00Z",
    auto_approve: false,
    created_at: "2026-06-01T00:00:00Z",
  };

  it("renders share card, SHOTS + CROWD stats, ZIP and live-roll links", async () => {
    fromMock.mockImplementation(() => eventDetailChain(liveEvent));
    const html = renderToStaticMarkup(
      await EventDetailPage({ params: { id: "e-1" } }),
    );
    // Header + status line ("Live · closes Jul 8" per mock screen 13).
    expect(html).toContain("ROLL CONTROL");
    expect(html).toContain("Lake House");
    expect(html).toContain("Live · closes Jul 8");
    // Share card: server-rendered QR, guest link, copy button.
    expect(html).toContain("data:image/png;base64,QRSTUB");
    expect(html).toContain("GUEST LINK");
    expect(html).toContain("localhost:3000/e/lake26");
    expect(html).toContain("Copy link");
    // Stats: SHOTS + CROWD only — LOOKS is dropped (no view tracking).
    expect(html).toContain("SHOTS");
    expect(html).toContain("132");
    expect(html).toContain("CROWD");
    expect(html).not.toContain("LOOKS");
    // ZIP + guest-view links.
    expect(html).toContain("/api/events/e-1/download");
    expect(html).toContain("DOWNLOAD ZIP");
    expect(html).toContain("VIEW LIVE ROLL");
    expect(html).toContain('href="/e/lake26"');
    // D4 sidebar current-event card.
    expect(html).toContain("CURRENT EVENT");
    // Grid tiles carry uploader names (polaroid chins).
    expect(html).toContain("Priya");
    expect(html).toContain("Anonymous");
    expect(html).toContain("Recent uploads");
  });

  it("renders the FRI-30 approval affordances for a pending shot", async () => {
    fromMock.mockImplementation(() => eventDetailChain(liveEvent));
    const html = renderToStaticMarkup(
      await EventDetailPage({ params: { id: "e-1" } }),
    );
    // The m-2 stub item is pending → the mock's reserved "Hidden" overlay
    // treatment plus a one-tap approve chip on the tile.
    expect(html).toContain(">Hidden</span>");
    expect(html).toContain("✓ APPROVE");
    // Moderation-queue filter pills appear once something is pending.
    expect(html).toContain(">Hidden<");
    // Count line surfaces the queue size next to the host total.
    expect(html).toContain("132 shots · 1 hidden");
    // Auto-approve toggle card in the share/stats column, defaulting OFF.
    expect(html).toContain("AUTO-APPROVE");
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("stay hidden until you approve them");
    // Opt-in ZIP link for the hidden queue sits under the main ZIP CTA.
    expect(html).toContain("/api/events/e-1/download?include=pending");
    expect(html).toContain("Include 1 hidden shot in the ZIP");
  });

  it("404s for an event the host does not own", async () => {
    fromMock.mockImplementation(() => eventDetailChain(null));
    let caught: unknown;
    try {
      await EventDetailPage({ params: { id: "someone-elses" } });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error)?.message).toBe("NOT_FOUND");
  });
});

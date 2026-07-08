import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getUser = vi.fn();
const upsert = vi.fn().mockResolvedValue({ error: null });
const isFn = vi.fn().mockResolvedValue({ error: null });
const eqFn = vi.fn(() => ({ is: isFn }));
const update = vi.fn(() => ({ eq: eqFn }));
const order = vi.fn().mockResolvedValue({ data: [], error: null });
const select = vi.fn(() => ({ order }));
const from = vi.fn((table: string) =>
  table === "events" ? { select } : { upsert, update },
);

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser }, from }),
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
}));

import DashboardPage from "@/app/dashboard/page";

describe("dashboard auth guard", () => {
  beforeEach(() => {
    getUser.mockReset();
    upsert.mockClear();
    update.mockClear();
    eqFn.mockClear();
    isFn.mockClear();
    from.mockClear();
    select.mockClear();
    order.mockClear();
  });

  it("redirects unauthenticated visitors to /sign-in", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    let caught: unknown;
    try {
      await DashboardPage();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RedirectError);
    expect((caught as RedirectError).location).toBe("/sign-in");
  });

  it("renders the dashboard for an authenticated user", async () => {
    getUser.mockResolvedValueOnce({
      data: {
        user: { id: "u-1", email: "host@example.com", phone: null },
      },
    });
    const tree = await DashboardPage();
    expect(tree).toBeTruthy();
    expect(renderToStaticMarkup(tree)).toContain("host@example.com");
    expect(from).toHaveBeenCalledWith("profiles");
    expect(upsert).toHaveBeenCalledWith(
      { id: "u-1" },
      { onConflict: "id", ignoreDuplicates: true },
    );
    // No signup name in metadata — nothing to backfill.
    expect(update).not.toHaveBeenCalled();
  });

  it("backfills profiles.full_name from signup metadata", async () => {
    getUser.mockResolvedValueOnce({
      data: {
        user: {
          id: "u-2",
          email: "new-host@example.com",
          phone: null,
          user_metadata: { full_name: "  Priya Rao  " },
        },
      },
    });
    await DashboardPage();
    expect(update).toHaveBeenCalledWith({ full_name: "Priya Rao" });
    expect(eqFn).toHaveBeenCalledWith("id", "u-2");
    // Only while unset — an edited profile name must never be clobbered.
    expect(isFn).toHaveBeenCalledWith("full_name", null);
  });
});

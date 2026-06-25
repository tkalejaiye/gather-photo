import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const upsert = vi.fn().mockResolvedValue({ error: null });
const from = vi.fn(() => ({ upsert }));

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
    from.mockClear();
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
    expect(JSON.stringify(tree)).toContain("host@example.com");
    expect(from).toHaveBeenCalledWith("profiles");
    expect(upsert).toHaveBeenCalledWith(
      { id: "u-1" },
      { onConflict: "id", ignoreDuplicates: true },
    );
  });
});

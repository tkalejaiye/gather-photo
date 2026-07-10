import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// FRI-35 — Daylight landing (/) and auth card (/sign-in) structure.

const getUser = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser } }),
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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import Home from "@/app/page";
import SignInPage from "@/app/sign-in/page";
import { SignInForm } from "@/app/sign-in/SignInForm";

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: null } });
  delete process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED;
});

describe("marketing landing (/)", () => {
  it("renders the Daylight welcome with mode-specific CTAs", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain("Every guest");
    expect(html).toContain("One live roll.");
    expect(html).toContain("/sign-in?mode=signup");
    expect(html).toContain("/sign-in?mode=login");
    expect(html).toContain("Create host account");
    expect(html).toContain("LOG IN");
  });

  // FRI-43 — lg+ D1 brand-panel hero alongside the unchanged mobile stack.
  it("carries the lg+ D1 hero: panel gradient, proof stats, on-orange CTAs", () => {
    const html = renderToStaticMarkup(<Home />);
    // The D1 panel signature (same gradient as the /sign-in aside).
    expect(html).toContain("linear-gradient(160deg,#FF8A1E 0%,#FF5A00 60%,#e24e00 100%)");
    expect(html).toContain("FOR GUESTS");
    expect(html).toContain("FOR THE WHOLE CROWD");
    // Both stacks (mobile + desktop hero) link both auth modes.
    expect(html.match(/\/sign-in\?mode=signup/g)).toHaveLength(2);
    expect(html.match(/\/sign-in\?mode=login/g)).toHaveLength(2);
    // Hero CTAs use the on-orange variants, not the gradient/paper pair.
    expect(html).toContain("bg-white font-display");
    expect(html).toContain("border-white/25");
  });
});

describe("sign-in page", () => {
  it("redirects an authenticated host to /dashboard", async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: "u-1" } } });
    let caught: unknown;
    try {
      await SignInPage({ searchParams: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RedirectError);
    expect((caught as RedirectError).location).toBe("/dashboard");
  });

  it("renders signup mode from ?mode=signup", async () => {
    const html = renderToStaticMarkup(
      await SignInPage({ searchParams: { mode: "signup" } }),
    );
    expect(html).toContain("CREATE ACCOUNT");
    expect(html).toContain("Start hosting");
    expect(html).toContain("Your name");
  });

  it("defaults a bare /sign-in to login mode", async () => {
    const html = renderToStaticMarkup(
      await SignInPage({ searchParams: {} }),
    );
    expect(html).toContain("WELCOME BACK");
    expect(html).toContain("Log in to host");
    expect(html).not.toContain("Your name");
  });

  it("shows the callback error", async () => {
    const html = renderToStaticMarkup(
      await SignInPage({ searchParams: { error: "missing_code" } }),
    );
    expect(html).toContain("missing its code");
  });
});

describe("auth card", () => {
  it("hides the Google button when the flag is off", () => {
    const html = renderToStaticMarkup(
      <SignInForm initialMode="signup" googleEnabled={false} />,
    );
    expect(html).not.toContain("Continue with Google");
  });

  it("shows the Google button when the flag is on", () => {
    const html = renderToStaticMarkup(
      <SignInForm initialMode="signup" googleEnabled={true} />,
    );
    expect(html).toContain("Continue with Google");
  });

  it("login mode drops the name field and offers the signup toggle", () => {
    const html = renderToStaticMarkup(
      <SignInForm initialMode="login" googleEnabled={false} />,
    );
    expect(html).not.toContain("Your name");
    expect(html).toContain("New here?");
    expect(html).toContain("Create account");
    expect(html).toContain("Email me a magic link");
  });

  it("signup mode has the name field and the login toggle", () => {
    const html = renderToStaticMarkup(
      <SignInForm initialMode="signup" googleEnabled={false} />,
    );
    expect(html).toContain("Your name");
    expect(html).toContain("Already hosting?");
  });
});

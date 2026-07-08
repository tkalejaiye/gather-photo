import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const signInWithOtp = vi.fn();
const verifyOtp = vi.fn();
const signInWithOAuth = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { signInWithOtp, verifyOtp, signInWithOAuth },
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

import {
  requestMagicLink,
  verifyEmailCode,
  signInWithGoogle,
} from "@/lib/auth/actions";

const APP_URL = "https://gather.test";
const CALLBACK = `${APP_URL}/auth/callback?next=/dashboard`;

beforeEach(() => {
  signInWithOtp.mockReset().mockResolvedValue({ error: null });
  verifyOtp.mockReset();
  signInWithOAuth.mockReset();
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  delete process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED;
});

describe("requestMagicLink", () => {
  it("rejects an invalid email without calling Supabase", async () => {
    const res = await requestMagicLink("not-an-email");
    expect(res).toEqual({ ok: false, error: expect.any(String) });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("normalizes the email and carries the signup name in user metadata", async () => {
    const res = await requestMagicLink("  Host@Email.COM ", "  Priya Rao ");
    expect(res).toEqual({ ok: true });
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "host@email.com",
      options: {
        emailRedirectTo: CALLBACK,
        data: { full_name: "Priya Rao" },
      },
    });
  });

  it("sends no metadata for login (no name)", async () => {
    await requestMagicLink("host@email.com");
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "host@email.com",
      options: { emailRedirectTo: CALLBACK },
    });
  });

  it("surfaces Supabase errors", async () => {
    signInWithOtp.mockResolvedValueOnce({
      error: { message: "rate limit exceeded" },
    });
    const res = await requestMagicLink("host@email.com");
    expect(res).toEqual({ ok: false, error: "rate limit exceeded" });
  });
});

describe("verifyEmailCode", () => {
  it("rejects an empty code without calling Supabase", async () => {
    const res = await verifyEmailCode("host@email.com", "   ");
    expect(res).toEqual({ ok: false, error: expect.any(String) });
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("verifies via the email channel and redirects to /dashboard", async () => {
    verifyOtp.mockResolvedValueOnce({
      data: { user: { id: "u-1" } },
      error: null,
    });
    let caught: unknown;
    try {
      await verifyEmailCode("Host@Email.com", "123456");
    } catch (e) {
      caught = e;
    }
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "host@email.com",
      token: "123456",
      type: "email",
    });
    expect(caught).toBeInstanceOf(RedirectError);
    expect((caught as RedirectError).location).toBe("/dashboard");
  });

  it("returns the Supabase error on a bad code", async () => {
    verifyOtp.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "Token has expired or is invalid" },
    });
    const res = await verifyEmailCode("host@email.com", "000000");
    expect(res).toEqual({
      ok: false,
      error: "Token has expired or is invalid",
    });
  });
});

describe("signInWithGoogle", () => {
  it("refuses without the env flag and never calls Supabase", async () => {
    const res = await signInWithGoogle();
    expect(res).toEqual({ ok: false, error: expect.any(String) });
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });

  it("fails loudly when the flag is on but the provider is misconfigured", async () => {
    process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED = "true";
    signInWithOAuth.mockResolvedValueOnce({
      data: { url: null },
      error: { message: "Unsupported provider: provider is not enabled" },
    });
    const res = await signInWithGoogle();
    expect(res).toEqual({
      ok: false,
      error: "Unsupported provider: provider is not enabled",
    });
  });

  it("redirects to the provider URL when configured", async () => {
    process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED = "true";
    signInWithOAuth.mockResolvedValueOnce({
      data: { url: "https://accounts.google.com/o/oauth2/auth?x=1" },
      error: null,
    });
    let caught: unknown;
    try {
      await signInWithGoogle();
    } catch (e) {
      caught = e;
    }
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: CALLBACK },
    });
    expect(caught).toBeInstanceOf(RedirectError);
    expect((caught as RedirectError).location).toContain(
      "accounts.google.com",
    );
  });
});

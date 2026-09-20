// The origin a deployment calls itself by (lib/site-url.ts).
//
// The bug this pins: NEXT_PUBLIC_APP_URL is one static value across every
// environment, so preview deployments sent magic links to PRODUCTION — you'd
// click the link and land on the live site, never on the build under test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { siteUrl, guestBaseUrl } from "@/lib/site-url";

const ENV_KEYS = [
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "NEXT_PUBLIC_APP_URL",
  "NODE_ENV",
] as const;

const saved: Record<string, string | undefined> = {};

// `process.env.NODE_ENV` is typed readonly; these tests need to simulate a
// production build, so go through a mutable view of the same object.
const env = process.env as Record<string, string | undefined>;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = env[k];
    delete env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("siteUrl — preview deployments", () => {
  it("uses the preview's OWN origin, not the production app URL", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_BRANCH_URL = "gather-photo-git-my-branch-team.vercel.app";
    process.env.NEXT_PUBLIC_APP_URL = "https://gather.photo";
    expect(siteUrl()).toBe("https://gather-photo-git-my-branch-team.vercel.app");
  });

  it("prefers the branch URL over the per-push deployment URL", () => {
    // VERCEL_URL changes on every push; the branch URL is stable, and this
    // origin has to stay on the Supabase redirect allowlist.
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_BRANCH_URL = "gather-photo-git-my-branch-team.vercel.app";
    process.env.VERCEL_URL = "gather-photo-a1b2c3-team.vercel.app";
    expect(siteUrl()).toBe("https://gather-photo-git-my-branch-team.vercel.app");
  });

  it("falls back to the deployment URL when no branch URL is present", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "gather-photo-a1b2c3-team.vercel.app";
    expect(siteUrl()).toBe("https://gather-photo-a1b2c3-team.vercel.app");
  });

  it("falls back to the configured app URL if Vercel gave us no host", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.NEXT_PUBLIC_APP_URL = "https://gather.photo";
    expect(siteUrl()).toBe("https://gather.photo");
  });
});

describe("siteUrl — production and local", () => {
  it("keeps the custom domain in production, never the deployment URL", () => {
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_URL = "gather-photo-a1b2c3-team.vercel.app";
    process.env.VERCEL_BRANCH_URL = "gather-photo-git-main-team.vercel.app";
    process.env.NEXT_PUBLIC_APP_URL = "https://gather.photo";
    expect(siteUrl()).toBe("https://gather.photo");
  });

  it("strips a trailing slash so callbacks don't end up double-slashed", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://gather.photo/";
    expect(siteUrl()).toBe("https://gather.photo");
  });

  it("ignores a blank app URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "   ";
    expect(siteUrl()).toBe("http://localhost:3000");
  });

  it("falls back to localhost for `next dev` with no env file", () => {
    expect(siteUrl()).toBe("http://localhost:3000");
  });
});

describe("guestBaseUrl — the QR code origin", () => {
  it("refuses to print a localhost QR on a production deploy", () => {
    env.NODE_ENV = "production";
    expect(() => guestBaseUrl()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it("resolves a preview deploy instead of throwing", () => {
    // A preview build still has NODE_ENV=production, so before this it either
    // threw or pointed the QR at the live site.
    env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_BRANCH_URL = "gather-photo-git-my-branch-team.vercel.app";
    expect(guestBaseUrl()).toBe("https://gather-photo-git-my-branch-team.vercel.app");
  });

  it("allows localhost outside production", () => {
    expect(guestBaseUrl()).toBe("http://localhost:3000");
  });
});

import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getEventPinSecret } from "./lookup";

const PIN_COOKIE_PREFIX = "gp_pin_";

export function pinCookieName(slug: string): string {
  return `${PIN_COOKIE_PREFIX}${slug}`;
}

// We store a SHA-256(pin + slug) in the cookie instead of the raw PIN so an
// accidental log or response capture doesn't leak the PIN itself. Slug acts
// as a salt — same PIN across two events produces different cookie values.
export function pinCookieValue(slug: string, pin: string): string {
  return createHash("sha256").update(`${slug}:${pin}`).digest("hex");
}

// Server-side gate. Keeps the raw PIN inside this helper — callers never
// see it, so it can't accidentally cross into a client component prop.
export async function hasValidPinCookie(slug: string): Promise<boolean> {
  const c = cookies().get(pinCookieName(slug));
  if (!c) return false;
  const expectedPin = await getEventPinSecret(slug);
  if (!expectedPin) return false;
  const expected = Buffer.from(pinCookieValue(slug, expectedPin), "hex");
  let actual: Buffer;
  try {
    actual = Buffer.from(c.value, "hex");
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// Constant-time string compare for verifying the PIN itself.
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

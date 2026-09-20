// The origin this deployment should call itself by — used for magic-link and
// OAuth callbacks (lib/auth/actions.ts) and for the guest URL baked into the
// QR code (app/dashboard/events/[id]/page.tsx).
//
// Why this isn't just `NEXT_PUBLIC_APP_URL`: that is ONE static value shared by
// every environment, so a preview deployment told Supabase to send the magic
// link to production. You'd click the link in your email and land on the live
// site instead of the build you were trying to test, which made preview deploys
// useless for anything behind auth — the only reachable page was /sign-in.
// Preview deployments each have their own origin and have to say so.
//
// Server-only. `VERCEL_*` are not `NEXT_PUBLIC_`, so they exist in server
// components, route handlers and server actions, and are undefined in the
// browser. Don't import this into a client component.
//
// Vercel sets these automatically on every deployment:
//   VERCEL_ENV         "production" | "preview" | "development"
//   VERCEL_BRANCH_URL  gather-photo-git-<branch>-<team>.vercel.app  (stable
//                      across redeploys of the same branch)
//   VERCEL_URL         gather-photo-<hash>-<team>.vercel.app  (changes on
//                      every single push)
//
// NOTE: an origin only works as a Supabase redirect target if it matches the
// allowlist under Auth → URL Configuration → Redirect URLs. Supabase silently
// falls back to Site URL otherwise — which is exactly the production-redirect
// symptom this module exists to fix. See RUNBOOK §9.

/** Resolved origin, or null when nothing is configured. Never trailing-slashed. */
function resolve(): string | null {
  // Preview: prefer the branch URL. It is stable across redeploys, which
  // matters because this origin has to be allowlisted in Supabase — a
  // per-push URL would need a new allowlist entry every time.
  if (process.env.VERCEL_ENV === "preview") {
    const host = process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
    if (host) return `https://${host}`;
  }
  // Production keeps the custom domain — never the ugly deployment URL.
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

/**
 * Origin for auth callbacks. Falls back to localhost so `next dev` works with
 * no env file.
 */
export function siteUrl(): string {
  return resolve() ?? "http://localhost:3000";
}

/**
 * Origin for guest-facing links (the QR code, the WhatsApp share). Fails loud
 * on a production deploy rather than silently printing a localhost QR onto a
 * wedding card.
 */
export function guestBaseUrl(): string {
  const resolved = resolve();
  if (resolved) return resolved;
  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_APP_URL must be set in production.");
  }
  return "http://localhost:3000";
}

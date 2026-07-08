"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

// Host auth is email magic link (+ optional Google OAuth) only — FRI-35.
// The phone/SMS channel was removed: it was never configured in Supabase.

// Same sanity gate the form uses (design/daylight/README.md §Interactions).
// Supabase does the real validation.
const EMAIL_RE = /\S+@\S+\.\S+/;

// Land magic links / OAuth on our callback so the PKCE code can be exchanged
// for a session (app/auth/callback/route.ts).
function callbackUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${appUrl}/auth/callback?next=/dashboard`;
}

export async function requestMagicLink(
  email: string,
  name?: string | null,
): Promise<ActionResult> {
  const value = email.trim().toLowerCase();
  if (!EMAIL_RE.test(value)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  const fullName = name?.trim() || null;

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: value,
    options: {
      emailRedirectTo: callbackUrl(),
      // Sign-up carries the host's name. It lands in auth user_metadata;
      // ensureProfile copies it onto profiles.full_name after first sign-in.
      ...(fullName ? { data: { full_name: fullName } } : {}),
    },
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// Fallback for when the magic link is awkward (e.g. reading mail on another
// device): the same email contains a 6-digit code that can be pasted here.
export async function verifyEmailCode(
  email: string,
  token: string,
): Promise<ActionResult> {
  const value = email.trim().toLowerCase();
  const code = token.trim();
  if (!code) return { ok: false, error: "Enter the code from the email." };

  const supabase = createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: value,
    token: code,
    type: "email",
  });

  if (error || !data.user) {
    return { ok: false, error: error?.message ?? "Could not verify code." };
  }

  // Profile-row creation is enforced by the dashboard guard so it also covers
  // users created out-of-band (Supabase dashboard, CLI, future flows).
  redirect("/dashboard");
}

// Gated behind NEXT_PUBLIC_GOOGLE_AUTH_ENABLED until the Supabase Google
// provider is configured (FRI-38). The UI hides the button when the flag is
// off; this server-side check is the backstop. With the flag on but the
// provider misconfigured, Supabase's error is returned so the failure is
// visible, never silent.
export async function signInWithGoogle(): Promise<ActionResult> {
  if (process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED !== "true") {
    return { ok: false, error: "Google sign-in isn't available yet." };
  }

  const supabase = createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callbackUrl() },
  });

  if (error || !data?.url) {
    return {
      ok: false,
      error: error?.message ?? "Google sign-in failed to start. Try the magic link.",
    };
  }

  redirect(data.url);
}

export async function signOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}

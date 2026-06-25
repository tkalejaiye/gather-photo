"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type OtpChannel = "email" | "phone";

export type ActionResult = { ok: true } | { ok: false; error: string };

function normalizeContact(channel: OtpChannel, raw: string): string {
  const v = raw.trim();
  if (channel === "email") return v.toLowerCase();
  // E.164-ish: strip spaces / dashes / parens. We do not validate further —
  // Supabase will reject malformed numbers.
  return v.replace(/[\s\-()]/g, "");
}

export async function requestOtp(
  channel: OtpChannel,
  contact: string,
): Promise<ActionResult> {
  const value = normalizeContact(channel, contact);
  if (!value) return { ok: false, error: "Enter your email or phone." };

  const supabase = createClient();
  // If the Supabase email template still uses {{ .ConfirmationURL }} (default),
  // the email is a magic link. Tell Supabase to land it on our callback so we
  // can exchange the PKCE code for a session.
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const emailRedirectTo = `${appUrl}/auth/callback?next=/dashboard`;

  const { error } =
    channel === "email"
      ? await supabase.auth.signInWithOtp({
          email: value,
          options: { emailRedirectTo },
        })
      : await supabase.auth.signInWithOtp({ phone: value });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function verifyOtp(
  channel: OtpChannel,
  contact: string,
  token: string,
): Promise<ActionResult> {
  const value = normalizeContact(channel, contact);
  const code = token.trim();
  if (!code) return { ok: false, error: "Enter the code we sent you." };

  const supabase = createClient();
  const { data, error } =
    channel === "email"
      ? await supabase.auth.verifyOtp({ email: value, token: code, type: "email" })
      : await supabase.auth.verifyOtp({ phone: value, token: code, type: "sms" });

  if (error || !data.user) {
    return { ok: false, error: error?.message ?? "Could not verify code." };
  }

  // Profile-row creation is enforced by the dashboard guard so it also covers
  // users created out-of-band (Supabase dashboard, CLI, future flows).
  redirect("/dashboard");
}

export async function signOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}

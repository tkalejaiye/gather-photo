"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/auth/ensureProfile";
import { getEventBySlug, getEventPinSecret } from "./lookup";
import { constantTimeEqual, pinCookieName, pinCookieValue } from "./pin";
import { generateSlug } from "./slug";

export type CreateEventInput = {
  name: string;
  eventDate?: string | null;
  pin?: string | null;
};

export type CreateEventResult =
  | { ok: true; id: string; slug: string }
  | { ok: false; error: string };

// Cap inserts on rare slug collisions. 70 bits of entropy means the loop
// almost never runs more than once, but better to fail loud than spin.
const MAX_SLUG_ATTEMPTS = 5;

export async function createEvent(
  input: CreateEventInput,
): Promise<CreateEventResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give your event a name." };

  const eventDate = input.eventDate?.trim() || null;
  const pin = input.pin?.trim() || null;
  if (pin && !/^[0-9]{4,8}$/.test(pin)) {
    return { ok: false, error: "PIN must be 4–8 digits." };
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You must be signed in." };

  // Required because events.host_id → profiles(id); a brand-new auth user
  // may not have a profiles row yet.
  await ensureProfile(supabase, user.id);

  // Until payments land (M4), allow events to be active immediately so the
  // critical-path guest flow can be exercised. M4 will flip default → 'draft'
  // and require a paid webhook to activate.
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = generateSlug();
    const { data, error } = await supabase
      .from("events")
      .insert({
        host_id: user.id,
        name,
        slug,
        pin,
        event_date: eventDate,
        status: "active",
      })
      .select("id, slug")
      .single();

    if (!error && data) return { ok: true, id: data.id, slug: data.slug };

    // 23505 = unique_violation. Any other error is fatal.
    const code = (error as { code?: string } | null)?.code;
    if (code !== "23505") {
      return { ok: false, error: error?.message ?? "Could not create event." };
    }
  }
  return { ok: false, error: "Could not allocate a unique slug. Try again." };
}

export async function createEventFromForm(formData: FormData) {
  const res = await createEvent({
    name: String(formData.get("name") ?? ""),
    eventDate: formData.get("event_date") ? String(formData.get("event_date")) : null,
    pin: formData.get("pin") ? String(formData.get("pin")) : null,
  });
  if (!res.ok) {
    redirect(`/dashboard/new?error=${encodeURIComponent(res.error)}`);
  }
  redirect(`/dashboard/events/${res.id}`);
}

const PIN_COOKIE_MAX_AGE = 60 * 60 * 8; // 8h — long enough for an event

export async function verifyEventPin(
  slug: string,
  pin: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const event = await getEventBySlug(slug);
  if (!event) return { ok: false, error: "Event not found." };
  if (!event.has_pin) return { ok: true };

  // PIN is short (4–8 digits) and therefore brute-forceable. Constant-time
  // compare blocks timing inference; full rate-limiting belongs to the
  // upload/verify endpoint hardening tracked in spec §9.
  const expected = await getEventPinSecret(slug);
  if (!expected || !constantTimeEqual(pin.trim(), expected)) {
    return { ok: false, error: "Wrong PIN." };
  }

  cookies().set(pinCookieName(slug), pinCookieValue(slug, expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/e/${slug}`,
    maxAge: PIN_COOKIE_MAX_AGE,
  });
  return { ok: true };
}

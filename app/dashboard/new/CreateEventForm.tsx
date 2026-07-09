"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Field } from "@/components/ui/field";
import { createEventFromForm } from "@/lib/events/actions";

// Daylight screen 12 (design/daylight/README.md) minus the cover-gradient
// picker — covers are FRI-29; the preview keeps the default orange gradient.
// The PIN field is not in the mock but is a shipped PRD §7 requirement
// (decision log on FRI-36). Client component only for the live preview +
// disabled-until-named submit; the create itself is the existing server
// action.

export function CreateEventForm({ error }: { error: string | null }) {
  const [name, setName] = useState("");
  // useFormStatus needs React 19 / Next's vendored canary; the installed
  // react-dom (18.3, what vitest resolves) lacks it. An onSubmit flag gives
  // the same pending label — a failed create redirects back with ?error=,
  // which remounts the form and clears it.
  const [submitting, setSubmitting] = useState(false);
  const ready = name.trim().length > 0;

  return (
    <div className="flex flex-1 flex-col">
      <Eyebrow className="mt-7">NEW EVENT</Eyebrow>
      <h1 className="mt-2 font-display text-[34px] tracking-[0.005em] text-daylight-ink">
        Create your event
      </h1>

      {/* Live cover preview — default orange gradient + uppercase name. */}
      <div
        aria-hidden
        className="relative mb-6 mt-[22px] flex h-[132px] flex-col justify-end overflow-hidden rounded-daylight-card bg-daylight-orange-grad p-4 shadow-daylight-card"
      >
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(transparent 30%, rgba(0,0,0,0.42))" }}
        />
        <div className="relative mb-1 font-mono text-[10px] font-bold tracking-[0.14em] text-white/85">
          GATHER.PHOTO
        </div>
        <div
          className={
            "relative break-words font-display text-[26px] uppercase leading-none " +
            (ready ? "text-white" : "text-white/60")
          }
        >
          {ready ? name : "Your event"}
        </div>
      </div>

      {error && <ErrorBanner message={error} className="mb-5" />}

      <form
        action={createEventFromForm}
        onSubmit={() => setSubmitting(true)}
        className="flex flex-1 flex-col"
      >
        <Field
          label="Event name"
          name="name"
          required
          maxLength={120}
          placeholder="Lake House '26"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {/* iOS Safari gives date inputs an intrinsic width/height that
            ignores w-full and overflows the column; appearance-none makes it
            size like a normal field, min-h matches the text fields (an empty
            date renders no value to derive height from), and the shadow-DOM
            value is centered by default on iOS — pin it left. */}
        <Field
          label="Date (optional)"
          name="event_date"
          type="date"
          className="mt-4"
          inputClassName="block min-h-[56px] appearance-none [&::-webkit-date-and-time-value]:text-left"
        />
        <Field
          label="PIN (optional, 4–8 digits)"
          name="pin"
          inputMode="numeric"
          pattern="[0-9]{4,8}"
          maxLength={8}
          placeholder="e.g. 2468"
          className="mt-4"
          inputClassName="tracking-[0.4em]"
        />
        <p className="mt-2 font-mono text-[11px] text-daylight-muted">
          Adds an extra gate before guests can upload.
        </p>

        <div className="min-h-7 flex-1" />

        <Button
          type="submit"
          variant="primary"
          disabled={!ready || submitting}
          className="w-full"
        >
          {submitting ? "Creating…" : "Create event & get link"}
        </Button>
      </form>
    </div>
  );
}

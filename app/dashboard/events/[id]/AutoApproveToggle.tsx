"use client";

import { useState, useTransition } from "react";
import { cx } from "@/components/ui/cx";
import { setAutoApprove } from "@/lib/events/actions";

// FRI-30: per-event moderation opt-out. OFF (default) = every new upload
// waits in the hidden queue until the host approves it; ON = new uploads
// publish straight to the roll. Rendered in the share/stats column of Roll
// Control so it sits next to the other event-level controls.
//
// Optimistic flip + rollback on failure: the toggle is a single boolean, so
// showing the new state immediately and reverting on error beats a spinner.
export function AutoApproveToggle({
  eventId,
  initialValue,
}: {
  eventId: string;
  initialValue: boolean;
}) {
  const [on, setOn] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    setError(null);
    startTransition(async () => {
      const res = await setAutoApprove(eventId, next);
      if (!res.ok) {
        setOn(!next);
        setError(res.error);
      }
    });
  }

  return (
    <div className="rounded-daylight-card border border-daylight-rule bg-white/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[11px] font-bold tracking-[0.1em] text-daylight-muted">
            AUTO-APPROVE
          </div>
          <p className="mt-1 text-[13px] leading-snug text-daylight-ink-soft">
            {on
              ? "New shots go straight to the roll."
              : "New shots stay hidden until you approve them."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Auto-approve new uploads"
          onClick={toggle}
          disabled={saving}
          className={cx(
            "relative h-7 w-12 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-60",
            on ? "bg-daylight-orange-grad" : "border border-daylight-rule bg-daylight-ink/[0.08]",
          )}
        >
          <span
            aria-hidden
            className={cx(
              "absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition-all",
              on ? "left-[26px]" : "left-[3px]",
            )}
          />
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 font-mono text-[11px] text-daylight-red-deep">
          {error}
        </p>
      )}
    </div>
  );
}

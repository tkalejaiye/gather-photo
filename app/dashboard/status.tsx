import { cx } from "@/components/ui/cx";

// Presentation helpers shared by the host dashboard routes (FRI-36).
// events.status values per 0001_init.sql: 'draft' | 'active' | 'expired'.

export function statusLabel(status: string): string {
  if (status === "active") return "Live";
  if (status === "draft") return "Draft";
  if (status === "expired") return "Ended";
  return status;
}

// "Jul 8". Render in UTC so a date-only value ("2026-07-08") doesn't shift
// a day for hosts west of Greenwich.
export function shortDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// "Jul 4, 2026" for the events list meta line.
export function fullDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// "Live · closes Jul 8" — the Roll Control status line (mock screen 13).
export function statusLine(status: string, uploadsCloseAt: string | null): string {
  const label = statusLabel(status);
  if (status === "active" && uploadsCloseAt) {
    return `${label} · closes ${shortDate(uploadsCloseAt)}`;
  }
  return label;
}

export function StatusChip({ status }: { status: string }) {
  const live = status === "active";
  return (
    <span
      className={cx(
        "shrink-0 rounded-daylight-chip px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.06em]",
        live
          ? "bg-daylight-orange-grad text-white"
          : "border border-daylight-rule bg-white/50 text-daylight-muted",
      )}
    >
      {statusLabel(status)}
    </span>
  );
}

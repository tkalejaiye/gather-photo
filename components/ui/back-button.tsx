import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

// 44px rounded square on translucent paper — 44px is also the minimum
// comfortable touch target. Defaults to a ← glyph; pass children to swap it
// (the viewer uses ✕).
export function BackButton({
  className,
  children,
  "aria-label": ariaLabel = "Back",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={cx(
        "flex h-11 w-11 items-center justify-center rounded-[12px] border border-daylight-rule",
        "bg-white/50 text-xl text-daylight-ink transition active:scale-[0.92]",
        className,
      )}
      {...props}
    >
      {children ?? "←"}
    </button>
  );
}

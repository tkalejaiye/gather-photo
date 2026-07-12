import type { HTMLAttributes } from "react";
import { cx } from "./cx";
import { archivo, archivoBlack, spaceMono } from "./fonts";

type ScreenShellProps = HTMLAttributes<HTMLDivElement> & {
  /** Classes for the inner content column (padding, alignment, …). */
  contentClassName?: string;
};

// Root wrapper for Daylight screens: paper background, warm ambient light,
// screen-enter fade, and the self-hosted font variables. Fonts load only on
// routes that render this shell, so not-yet-migrated screens stay untouched
// and pay no font bytes.
// Heights use svh, not dvh (FRI-42): iOS Safari's dynamic viewport grows when
// the toolbar collapses, so dvh-centered layouts recenter and the top gap
// jumps between visits. svh is stable across toolbar states; the extra room
// appears at the bottom instead — accepted trade-off.
export function ScreenShell({
  className,
  contentClassName,
  children,
  ...props
}: ScreenShellProps) {
  return (
    <div
      className={cx(
        archivo.variable,
        archivoBlack.variable,
        spaceMono.variable,
        "relative min-h-svh bg-daylight-paper font-sans text-daylight-ink",
        className,
      )}
      {...props}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-daylight-ambient" />
      <div className={cx("relative flex min-h-svh animate-gp-fade flex-col", contentClassName)}>
        {children}
      </div>
    </div>
  );
}

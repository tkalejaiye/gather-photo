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
        "relative min-h-dvh bg-daylight-paper font-sans text-daylight-ink",
        className,
      )}
      {...props}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-daylight-ambient" />
      <div className={cx("relative flex min-h-dvh animate-gp-fade flex-col", contentClassName)}>
        {children}
      </div>
    </div>
  );
}

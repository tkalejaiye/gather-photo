import type { HTMLAttributes } from "react";
import { cx } from "./cx";

// Section eyebrow: "CREATE ACCOUNT", "● ROLL 01 · LIVE", …
export function Eyebrow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        "font-mono text-xs font-bold uppercase tracking-[0.16em] text-daylight-orange-deep",
        className,
      )}
      {...props}
    />
  );
}

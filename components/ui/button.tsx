import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type DaylightButtonVariant = "primary" | "secondary" | "text";

// Values are hi-fi from design/daylight/ mocks: 18px/15px padding, 14px
// radius, orange glow shadow; disabled = flat ink-8% fill, no glow, .5
// opacity. Secondary/text labels are typed uppercase by callers (mock does
// not set text-transform on them).
const variantClasses: Record<DaylightButtonVariant, string> = {
  primary: cx(
    "inline-flex items-center justify-center gap-2 rounded-daylight-btn p-[18px]",
    "bg-daylight-orange-grad font-display text-base uppercase tracking-[0.02em] text-white",
    "shadow-daylight-btn transition active:scale-[0.97]",
    "disabled:cursor-not-allowed disabled:bg-none disabled:bg-daylight-ink/[0.08] disabled:opacity-50 disabled:shadow-none",
  ),
  secondary: cx(
    "inline-flex items-center justify-center gap-2 rounded-daylight-btn border border-daylight-rule p-[15px]",
    "bg-white/50 font-mono text-[13px] font-bold tracking-[0.06em] text-daylight-ink",
    "transition active:scale-[0.97]",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ),
  text: cx(
    "inline-flex items-center justify-center gap-1 p-1.5",
    "font-mono text-xs text-daylight-muted",
    "transition active:scale-[0.97]",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ),
};

// For styling non-<button> elements (e.g. <Link>) as Daylight buttons.
export function daylightButtonClasses(
  variant: DaylightButtonVariant,
  className?: string,
): string {
  return cx(variantClasses[variant], className);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: DaylightButtonVariant;
};

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button type={type} className={daylightButtonClasses(variant, className)} {...props} />
  );
}

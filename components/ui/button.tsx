import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type DaylightButtonVariant =
  | "primary"
  | "secondary"
  | "text"
  | "primaryOnOrange"
  | "secondaryOnOrange";

// Values are hi-fi from design/daylight/ mocks: 18px/15px padding, 14px
// radius, orange glow shadow; disabled = flat ink-8% fill, no glow, .5
// opacity. Secondary/text labels are typed uppercase by callers (mock does
// not set text-transform on them).
//
// The *OnOrange pair is for CTAs sitting on the orange brand panel (FRI-43),
// where the gradient primary and paper secondary vanish into the background.
// Primary inverts to a solid white print with a deep-orange label (precedent:
// D1's white Google button); secondary takes the mock's translucent panel
// treatment (white 25% border, 12% fill). Both drop the orange glow for a
// warm-dark shadow — glow reads as mud on the gradient.
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
  primaryOnOrange: cx(
    "inline-flex items-center justify-center gap-2 rounded-daylight-btn p-[18px]",
    "bg-white font-display text-base uppercase tracking-[0.02em] text-daylight-orange-deeper",
    "shadow-[0_12px_28px_rgba(60,30,0,0.28)] transition active:scale-[0.97]",
    "disabled:cursor-not-allowed disabled:bg-white/40 disabled:opacity-50 disabled:shadow-none",
  ),
  secondaryOnOrange: cx(
    "inline-flex items-center justify-center gap-2 rounded-daylight-btn border border-white/25 p-[15px]",
    "bg-white/[0.12] font-mono text-[13px] font-bold tracking-[0.06em] text-white",
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

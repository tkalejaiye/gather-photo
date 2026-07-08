import { useId, type InputHTMLAttributes } from "react";
import { cx } from "./cx";

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  /** Classes for the wrapping div; use inputClassName for the input itself. */
  className?: string;
  inputClassName?: string;
};

// Labeled input: Space Mono eyebrow-style label over a translucent paper
// input with the orange focus ring. useId keeps the label/input pairing
// valid from server components.
export function Field({
  label,
  id,
  className,
  inputClassName,
  ...inputProps
}: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-daylight-muted"
      >
        {label}
      </label>
      <input
        id={inputId}
        className={cx(
          "mt-[7px] w-full rounded-daylight-field border border-daylight-rule bg-white/60 p-[15px]",
          "font-sans text-base font-bold text-daylight-ink outline-none transition",
          "focus:border-daylight-orange focus:shadow-daylight-focus",
          inputClassName,
        )}
        {...inputProps}
      />
    </div>
  );
}

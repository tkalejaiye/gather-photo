import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

type PolaroidProps = HTMLAttributes<HTMLDivElement> & {
  /** Tilt in degrees. Stored in --r so the float animation keeps it. */
  rotate?: number;
  /** Gentle bob (gp-float, 5.5s). */
  float?: boolean;
  /** Stagger for clusters, e.g. ".5s". */
  floatDelay?: string;
  /** Film-style stamp over the photo's bottom-right, e.g. "07·05·26". */
  dateStamp?: string;
  /** White frame padding; the larger bottom edge is the polaroid chin. */
  padding?: string;
  children: ReactNode;
};

// Photo "print" motif: white frame with a chin, slight tilt, warm shadow.
// Children fill the photo area (real images use object-fit: cover).
export function Polaroid({
  rotate = 0,
  float = false,
  floatDelay,
  dateStamp,
  padding = "8px 8px 24px",
  className,
  style,
  children,
  ...props
}: PolaroidProps) {
  const frameStyle = {
    ...style,
    padding,
    "--r": `${rotate}deg`,
    transform: `rotate(${rotate}deg)`,
    ...(floatDelay ? { animationDelay: floatDelay } : {}),
  } as CSSProperties;
  return (
    <div
      className={cx(
        "rounded-daylight-print bg-white shadow-daylight-print",
        float && "animate-gp-float",
        className,
      )}
      style={frameStyle}
      {...props}
    >
      <div className="relative overflow-hidden rounded-[2px]">
        {children}
        {dateStamp ? (
          <span className="absolute bottom-[7px] right-2 font-mono text-[9px] text-daylight-stamp [text-shadow:0_1px_2px_rgba(0,0,0,0.5)]">
            {dateStamp}
          </span>
        ) : null}
      </div>
    </div>
  );
}

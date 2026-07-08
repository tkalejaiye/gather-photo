import { cx } from "./cx";

type WordmarkProps = {
  /** "ink" on paper (default); "white" on the orange brand panel. */
  tone?: "ink" | "white";
  className?: string;
};

// The brand is set type, no raster asset: ◉ badge + "GATHER.PHOTO" in
// Archivo Black. On paper the ".PHOTO" goes orange; on the orange panel the
// whole mark is white with a translucent badge.
export function Wordmark({ tone = "ink", className }: WordmarkProps) {
  const onOrange = tone === "white";
  return (
    <div className={cx("flex items-center", onOrange ? "gap-3" : "gap-2.5", className)}>
      <div
        aria-hidden
        className={cx(
          "flex items-center justify-center text-white",
          onOrange
            ? "h-[38px] w-[38px] rounded-[10px] bg-white/[0.22] text-xl"
            : "h-[30px] w-[30px] rounded-lg bg-daylight-orange-grad text-[15px]",
        )}
      >
        ◉
      </div>
      <span
        className={cx(
          "font-display tracking-[0.02em]",
          onOrange ? "text-xl text-white" : "text-[17px] text-daylight-ink",
        )}
      >
        GATHER
        <span className={onOrange ? undefined : "text-daylight-orange"}>.PHOTO</span>
      </span>
    </div>
  );
}

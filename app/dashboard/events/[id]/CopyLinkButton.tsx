"use client";

import { useState } from "react";
import { cx } from "@/components/ui/cx";

export function CopyLinkButton({ url, className }: { url: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      // 1.6s per the mock (design/daylight/README.md §Interactions).
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Older browsers without the clipboard API — leave the link visible
      // so the host can long-press / select manually.
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className={cx(
        "rounded-[9px] bg-daylight-orange-grad px-4 py-[9px] font-mono text-xs font-bold text-white",
        "shadow-[0_8px_20px_rgba(255,106,0,0.3)] transition active:scale-[0.95]",
        className,
      )}
    >
      {copied ? "Copied ✓" : "Copy link"}
    </button>
  );
}

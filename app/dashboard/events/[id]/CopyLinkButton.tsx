"use client";

import { useState } from "react";

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers without the clipboard API — leave the link visible
      // so the host can long-press / select manually.
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:border-neutral-500"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

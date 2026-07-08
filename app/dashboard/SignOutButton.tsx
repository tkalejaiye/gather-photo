"use client";

import { useTransition } from "react";
import { signOut } from "@/lib/auth/actions";

export function SignOutButton() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      onClick={() => startTransition(() => signOut())}
      disabled={pending}
      className="rounded-daylight-chip border border-daylight-rule bg-white/50 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-daylight-ink-soft transition active:scale-[0.95] disabled:opacity-50"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

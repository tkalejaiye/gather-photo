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
      className="rounded border border-neutral-700 px-3 py-1 text-sm text-neutral-200 hover:border-neutral-500 disabled:opacity-50"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

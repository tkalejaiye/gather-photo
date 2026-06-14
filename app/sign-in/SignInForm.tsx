"use client";

import { useState, useTransition } from "react";
import { requestOtp, verifyOtp, type OtpChannel } from "@/lib/auth/actions";

export function SignInForm() {
  const [channel, setChannel] = useState<OtpChannel>("email");
  const [contact, setContact] = useState("");
  const [token, setToken] = useState("");
  const [step, setStep] = useState<"contact" | "verify">("contact");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await requestOtp(channel, contact);
      if (!res.ok) setError(res.error);
      else setStep("verify");
    });
  }

  function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await verifyOtp(channel, contact, token);
      // On success, verifyOtp redirects — we only land here on failure.
      if (res && !res.ok) setError(res.error);
    });
  }

  const inputClass =
    "w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none";

  if (step === "verify") {
    return (
      <form onSubmit={onVerify} className="mt-6 space-y-4">
        <p className="text-sm text-neutral-300">
          {channel === "email" ? (
            <>
              We emailed <span className="font-medium">{contact}</span>. Open
              the link in that email to finish signing in — or, if you received
              a 6-digit code, paste it below.
            </>
          ) : (
            <>
              We sent a code to <span className="font-medium">{contact}</span>.
            </>
          )}
        </p>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-neutral-400">
            Code
          </span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={`mt-1 ${inputClass}`}
            required
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Verifying…" : "Verify"}
        </button>
        <button
          type="button"
          onClick={() => {
            setStep("contact");
            setToken("");
            setError(null);
          }}
          className="text-xs text-neutral-400 underline"
        >
          Use a different {channel === "email" ? "email" : "phone number"}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={onRequest} className="mt-6 space-y-4">
      <div className="flex gap-2 text-sm">
        {(["email", "phone"] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => {
              setChannel(c);
              setContact("");
              setError(null);
            }}
            className={`rounded px-3 py-1 ${
              channel === c
                ? "bg-brand text-white"
                : "border border-neutral-700 text-neutral-300"
            }`}
          >
            {c === "email" ? "Email" : "Phone"}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="text-xs uppercase tracking-wide text-neutral-400">
          {channel === "email" ? "Email" : "Phone (with country code)"}
        </span>
        <input
          type={channel === "email" ? "email" : "tel"}
          autoComplete={channel === "email" ? "email" : "tel"}
          inputMode={channel === "email" ? "email" : "tel"}
          placeholder={channel === "email" ? "you@example.com" : "+2348012345678"}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          className={`mt-1 ${inputClass}`}
          required
        />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Sending…" : "Send code"}
      </button>
    </form>
  );
}

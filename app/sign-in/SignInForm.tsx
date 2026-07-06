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

  if (step === "verify") {
    return (
      <form onSubmit={onVerify} className="mt-6 space-y-4">
        <p className="text-sm text-ink-100">
          {channel === "email" ? (
            <>
              We emailed <span className="font-semibold text-white">{contact}</span>.
              Open the link in that email to finish signing in — or, if you
              received a 6-digit code, paste it below.
            </>
          ) : (
            <>
              We sent a code to{" "}
              <span className="font-semibold text-white">{contact}</span>.
            </>
          )}
        </p>
        <label className="block">
          <span className="field-label">Code</span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="input mt-2 text-center text-lg tracking-[0.4em]"
            placeholder="123456"
            required
          />
        </label>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <button type="submit" disabled={pending} className="btn-pop w-full">
          {pending ? "Verifying…" : "Verify →"}
        </button>
        <button
          type="button"
          onClick={() => {
            setStep("contact");
            setToken("");
            setError(null);
          }}
          className="text-xs text-ink-300 underline underline-offset-4 transition hover:text-white"
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
            className={
              channel === c
                ? "chip chip-active"
                : "chip"
            }
          >
            {c === "email" ? "Email" : "Phone"}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="field-label">
          {channel === "email" ? "Email" : "Phone (with country code)"}
        </span>
        <input
          type={channel === "email" ? "email" : "tel"}
          autoComplete={channel === "email" ? "email" : "tel"}
          inputMode={channel === "email" ? "email" : "tel"}
          placeholder={channel === "email" ? "you@example.com" : "+2348012345678"}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          className="input mt-2"
          required
        />
      </label>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <button type="submit" disabled={pending} className="btn-pop w-full">
        {pending ? "Sending…" : "Send me a code →"}
      </button>
    </form>
  );
}

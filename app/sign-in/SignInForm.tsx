"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Field } from "@/components/ui/field";
import {
  requestMagicLink,
  signInWithGoogle,
  verifyEmailCode,
} from "@/lib/auth/actions";

// Daylight auth card (FRI-35) — screens 9 (Sign up), 10 (Log in) and 11
// (Check your email) from design/daylight/README.md. Renders as a
// full-height mobile stack; the parent (app/sign-in/page.tsx) centers it as
// the D1 form card on lg+.
//
// The mock's "◉ I opened the link" button was prototype-only simulation —
// the real magic link navigates to /auth/callback. In its place the
// check-email screen keeps the pre-Daylight 6-digit code paste as the
// fallback path (mail open on another device, link blocked, …).

export type AuthMode = "signup" | "login";

// Same gate as the server action (design §Interactions).
const EMAIL_RE = /\S+@\S+\.\S+/;

const MODE_COPY: Record<AuthMode, { eyebrow: string; title: string }> = {
  signup: { eyebrow: "CREATE ACCOUNT", title: "Start hosting" },
  login: { eyebrow: "WELCOME BACK", title: "Log in to host" },
};

type Props = {
  initialMode: AuthMode;
  initialError?: string | null;
  googleEnabled: boolean;
};

export function SignInForm({ initialMode, initialError, googleEnabled }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [step, setStep] = useState<"form" | "sent">("form");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [pending, startTransition] = useTransition();

  const emailValid = EMAIL_RE.test(email);
  const canSubmit = emailValid && (mode === "login" || name.trim().length > 0);

  function switchMode(next: AuthMode) {
    setMode(next);
    setError(null);
    // Keep the URL shareable/refreshable without a server round-trip.
    try {
      window.history.replaceState(null, "", `/sign-in?mode=${next}`);
    } catch {
      // history API unavailable — cosmetic only
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await requestMagicLink(
        email,
        mode === "signup" ? name : null,
      );
      if (!res.ok) {
        setError(res.error);
      } else {
        setSentTo(email.trim().toLowerCase());
        setCode("");
        setStep("sent");
      }
    });
  }

  function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await verifyEmailCode(sentTo, code);
      // On success verifyEmailCode redirects — we only land here on failure.
      if (res && !res.ok) setError(res.error);
    });
  }

  function onGoogle() {
    setError(null);
    startTransition(async () => {
      const res = await signInWithGoogle();
      // On success the action redirects to the provider; a return value means
      // the flag/provider is misconfigured — surface it, never fail silent.
      if (res && !res.ok) setError(res.error);
    });
  }

  function backToForm() {
    setStep("form");
    setError(null);
  }

  const wrapper = cx(
    "mx-auto flex min-h-dvh w-full max-w-[440px] flex-col pb-10 pt-[70px]",
    "lg:mx-0 lg:min-h-0 lg:max-w-[400px] lg:p-0",
  );

  if (step === "sent") {
    return (
      <div className={cx(wrapper, "px-[34px] lg:px-0")}>
        <BackButton className="lg:hidden" onClick={backToForm} />

        <div className="flex flex-1 flex-col items-center justify-center gap-6 py-8 text-center lg:flex-none">
          <div className="flex h-[104px] w-[104px] items-center justify-center rounded-[26px] border border-daylight-rule bg-white/60 shadow-daylight-card">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden>
              <rect x="7" y="12" width="34" height="24" rx="4" stroke="#FF6A00" strokeWidth="3" />
              <path
                d="M9 15l15 11 15-11"
                stroke="#FF6A00"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            <h1 className="font-display text-[32px] tracking-[0.005em] text-daylight-ink">
              Check your email
            </h1>
            <p className="mx-auto mt-3 max-w-[290px] text-base leading-normal text-daylight-ink-soft">
              We sent a magic link to{" "}
              <span className="font-mono font-bold text-daylight-ink">{sentTo}</span>
              . Tap it to finish signing in.
            </p>
          </div>
        </div>

        {error && <ErrorBanner message={error} className="mb-4" />}

        <form onSubmit={onVerify} className="flex flex-col gap-4">
          <Field
            label="Got a code instead? Paste it"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputClassName="text-center text-lg tracking-[0.4em]"
          />
          <Button
            type="submit"
            className="w-full"
            disabled={code.trim().length < 6 || pending}
          >
            {pending ? "Verifying…" : "Verify code"}
          </Button>
          <button
            type="button"
            onClick={backToForm}
            className="p-1.5 text-center font-mono text-xs text-daylight-muted transition active:scale-[0.97]"
          >
            Didn&apos;t get it?{" "}
            <span className="font-bold text-daylight-orange-deep">
              Resend or change email
            </span>
          </button>
        </form>
      </div>
    );
  }

  const copy = MODE_COPY[mode];

  return (
    <div className={cx(wrapper, "px-[26px] lg:px-0")}>
      <BackButton className="lg:hidden" onClick={() => router.push("/")} />

      <div className="mt-6 lg:mt-0">
        <Eyebrow>{copy.eyebrow}</Eyebrow>
        <h1 className="mt-2.5 font-display text-[34px] tracking-[0.005em] text-daylight-ink lg:text-4xl">
          {copy.title}
        </h1>
        {mode === "signup" && (
          <p className="mt-1 hidden text-[15px] text-daylight-ink-soft lg:block">
            Free to set up. Your first event takes about a minute.
          </p>
        )}
      </div>

      {error && <ErrorBanner message={error} className="mt-5" />}

      {googleEnabled ? (
        <div className="mt-[26px]">
          <button
            type="button"
            onClick={onGoogle}
            disabled={pending}
            className={cx(
              "flex w-full items-center justify-center gap-[11px] rounded-daylight-btn border border-daylight-rule bg-white p-[15px]",
              "font-sans text-[15px] font-bold text-daylight-ink shadow-daylight-card-sm",
              "transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <GoogleG />
            Continue with Google
          </button>
          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-daylight-rule" />
            <span className="font-mono text-[11px] text-daylight-muted">or</span>
            <div className="h-px flex-1 bg-daylight-rule" />
          </div>
        </div>
      ) : (
        <div aria-hidden className="h-[26px]" />
      )}

      <form onSubmit={onSubmit} className="flex flex-1 flex-col lg:flex-none">
        {mode === "signup" && (
          <Field
            label="Your name"
            placeholder="Priya Rao"
            maxLength={40}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mb-4"
          />
        )}
        <Field
          label="Email"
          type="email"
          placeholder="you@email.com"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <div aria-hidden className="min-h-6 flex-1 lg:flex-none" />
        <Button
          type="submit"
          className="w-full"
          disabled={!canSubmit || pending}
        >
          {pending ? "Sending…" : "Email me a magic link"}
        </Button>
      </form>

      <button
        type="button"
        onClick={() => switchMode(mode === "signup" ? "login" : "signup")}
        className="mt-3 p-1.5 text-center font-mono text-xs text-daylight-muted transition active:scale-[0.97]"
      >
        {mode === "signup" ? "Already hosting? " : "New here? "}
        <span className="font-bold text-daylight-orange-deep">
          {mode === "signup" ? "Log in" : "Create account"}
        </span>
      </button>
    </div>
  );
}

function ErrorBanner({ message, className }: { message: string; className?: string }) {
  return (
    <p
      role="alert"
      className={cx(
        "rounded-daylight-field border border-daylight-red/50 bg-daylight-red/10 px-4 py-3 text-sm text-daylight-red-deep",
        className,
      )}
    >
      {message}
    </p>
  );
}

// Inline multicolor G from the mock (README §Assets) — no OAuth button
// component exists in the codebase to reuse.
function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.5 0 10.5-2.1 14.3-5.6l-6.6-5.6C29.7 34.6 27 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4.1 5.8l6.6 5.6C41.4 36.9 44 31.1 44 24c0-1.3-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}

import Link from "next/link";

export default function Home() {
  return (
    <main className="app-shell flex min-h-screen flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-6">
        <span className="chip">
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-pop-400" />
          gather.photo · Lagos&apos;s party camera roll
        </span>
        <h1 className="h-display text-[56px] leading-[0.95] sm:text-[72px]">
          Every guest&apos;s{" "}
          <span className="bg-pop-gradient bg-clip-text text-transparent">
            photos
          </span>
          , in one roll.
        </h1>
        <p className="max-w-md text-base text-ink-100 sm:text-lg">
          One QR code. No app. No login. Guests shoot, and every frame lands in
          your private gallery — even when the wifi doesn&apos;t.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <Link href="/sign-in" className="btn-pop">
            Host an event →
          </Link>
          <a
            href="#how"
            className="btn-ghost"
            aria-label="Learn how gather.photo works"
          >
            How it works
          </a>
        </div>
        <p className="text-xs text-ink-300">
          Free while we&apos;re in beta · Built for weddings, birthdays, and
          Detty December.
        </p>
      </div>
    </main>
  );
}

import Link from "next/link";
import { daylightButtonClasses } from "@/components/ui/button";
import { Polaroid } from "@/components/ui/polaroid";
import { ScreenShell } from "@/components/ui/screen-shell";
import { Wordmark } from "@/components/ui/wordmark";

// Daylight Welcome (design/daylight/README.md §Screen 8) doubling as the
// marketing landing — the design has no separate marketing page (FRI-35).
// Below lg this is the mobile Welcome stack, unchanged. At lg+ the screen
// takes the D1 brand-panel language as a full-bleed hero (FRI-43, design
// review Jul 9 2026): same gradient, copy, and stats as the /sign-in aside,
// so clicking through reads as the form card sliding into the panel.

export default function Home() {
  return (
    <ScreenShell>
      <main className="flex flex-1 flex-col">
        {/* < lg: Welcome stack (mock screen 8). */}
        <div className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-[26px] pb-11 pt-[74px] lg:hidden">
          <Wordmark />

          <div className="flex flex-1 flex-col justify-center gap-[22px] py-10">
            <div aria-hidden className="relative h-[150px]">
              <Polaroid rotate={-9} float className="absolute left-2 top-3 w-28">
                <div
                  className="h-[92px]"
                  style={{ background: "linear-gradient(150deg,#17B7A6,#0c5b52)" }}
                />
              </Polaroid>
              <Polaroid
                rotate={5}
                float
                floatDelay=".5s"
                className="absolute left-[104px] top-0.5 w-[116px]"
              >
                <div
                  className="h-[98px]"
                  style={{ background: "linear-gradient(150deg,#F5852A,#a34a12)" }}
                />
              </Polaroid>
              <Polaroid
                rotate={12}
                float
                floatDelay="1s"
                padding="7px 7px 22px"
                className="absolute right-1 top-5 w-24"
              >
                <div
                  className="h-20"
                  style={{ background: "linear-gradient(150deg,#E9C33C,#a3791c)" }}
                />
              </Polaroid>
            </div>

            <div>
              <h1 className="font-display text-[42px] leading-[0.95] tracking-[0.005em] text-daylight-ink">
                Every guest&apos;s photos.
                <br />
                <span className="text-daylight-orange">One live roll.</span>
              </h1>
              <p className="mt-4 max-w-[300px] text-base leading-normal text-daylight-ink-soft">
                Create an event, share one link, and watch the shots roll in — no
                app for your guests.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Link
              href="/sign-in?mode=signup"
              className={daylightButtonClasses("primary", "w-full")}
            >
              Create host account
            </Link>
            <Link
              href="/sign-in?mode=login"
              className={daylightButtonClasses("secondary", "w-full")}
            >
              LOG IN
            </Link>
          </div>
        </div>

        {/* lg+: D1 brand panel, full bleed (gradient + highlights + copy match
            the /sign-in aside; polaroids float where the form card lands). */}
        <section
          className="relative hidden flex-1 overflow-hidden p-14 lg:flex lg:flex-col lg:justify-between"
          style={{
            background:
              "linear-gradient(160deg,#FF8A1E 0%,#FF5A00 60%,#e24e00 100%)",
          }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(80% 60% at 90% 8%, rgba(255,255,255,0.22), transparent 55%), radial-gradient(70% 50% at -6% 100%, rgba(23,183,166,0.35), transparent 55%)",
            }}
          />
          <Wordmark tone="white" className="relative" />

          <div className="relative">
            <h1 className="max-w-[560px] font-display text-6xl leading-[0.94] tracking-[0.005em] text-white xl:max-w-none">
              Every guest&apos;s photos.
              <br />
              One live roll.
            </h1>
            <p className="mt-[22px] max-w-[440px] text-lg leading-[1.55] text-white/[0.92]">
              Create an event, share one link or QR, and watch the shots roll in
              as the night happens — no app for your guests, ever.
            </p>
            <div className="mt-9 flex w-full max-w-[440px] gap-3.5">
              <Link
                href="/sign-in?mode=signup"
                className={daylightButtonClasses("primaryOnOrange", "flex-1 px-7")}
              >
                Create host account
              </Link>
              <Link
                href="/sign-in?mode=login"
                className={daylightButtonClasses("secondaryOnOrange", "px-7")}
              >
                LOG IN
              </Link>
            </div>
          </div>

          <div className="relative flex gap-9">
            <div>
              <div className="font-display text-3xl text-white">no app</div>
              <div className="mt-0.5 font-mono text-xs text-white/80">
                FOR GUESTS
              </div>
            </div>
            <div>
              <div className="font-display text-3xl text-white">one link</div>
              <div className="mt-0.5 font-mono text-xs text-white/80">
                FOR THE WHOLE CROWD
              </div>
            </div>
          </div>

          <div aria-hidden className="pointer-events-none absolute inset-0">
            <Polaroid
              rotate={8}
              float
              dateStamp="07·05·26"
              padding="12px 12px 34px"
              className="absolute left-[64%] top-[110px] w-[200px] shadow-[0_24px_50px_rgba(60,30,0,0.4)]"
            >
              <div
                className="h-[168px]"
                style={{ background: "linear-gradient(150deg,#17B7A6,#0c5b52)" }}
              />
            </Polaroid>
            <Polaroid
              rotate={-7}
              float
              floatDelay=".5s"
              padding="10px 10px 30px"
              className="absolute left-[78%] top-[44%] w-[180px] shadow-[0_24px_50px_rgba(60,30,0,0.35)]"
            >
              <div
                className="h-[148px]"
                style={{ background: "linear-gradient(150deg,#F5852A,#a34a12)" }}
              />
            </Polaroid>
            <Polaroid
              rotate={13}
              float
              floatDelay="1s"
              dateStamp="07·04·26"
              padding="10px 10px 30px"
              className="absolute -right-10 top-[68%] w-[190px] shadow-[0_24px_50px_rgba(60,30,0,0.35)]"
            >
              <div
                className="h-[156px]"
                style={{ background: "linear-gradient(150deg,#E9C33C,#a3791c)" }}
              />
            </Polaroid>
          </div>
        </section>
      </main>
    </ScreenShell>
  );
}

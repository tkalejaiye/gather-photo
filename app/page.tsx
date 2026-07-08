import Link from "next/link";
import { daylightButtonClasses } from "@/components/ui/button";
import { Polaroid } from "@/components/ui/polaroid";
import { ScreenShell } from "@/components/ui/screen-shell";
import { Wordmark } from "@/components/ui/wordmark";

// Daylight Welcome (design/daylight/README.md §Screen 8) doubling as the
// marketing landing — the design has no separate marketing page (FRI-35).
// No desktop mock exists for this screen, so per README §Target the stack is
// constrained to ~440px and centered on the warm background at larger sizes.

export default function Home() {
  return (
    <ScreenShell contentClassName="lg:items-center lg:justify-center">
      <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-[26px] pb-11 pt-[74px] lg:min-h-0 lg:flex-none lg:py-16">
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
      </main>
    </ScreenShell>
  );
}

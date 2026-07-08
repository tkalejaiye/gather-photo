import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Polaroid } from "@/components/ui/polaroid";
import { ScreenShell } from "@/components/ui/screen-shell";
import { Wordmark } from "@/components/ui/wordmark";
import { SignInForm, type AuthMode } from "./SignInForm";

export const metadata = { title: "Sign in · gather.photo" };

type Props = {
  searchParams: { mode?: string; error?: string };
};

// Host auth (FRI-35): Daylight screens 9–11 on mobile, desktop anchor D1
// (46% orange brand panel + form card) at lg and up. Guests never see this —
// they enter through /e/[slug] with no login.
export default async function SignInPage({ searchParams }: Props) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  // Landing CTAs pass the mode; a bare /sign-in hit (post-signout, "Manage →"
  // from a guest page) is most likely a returning host, so default to login.
  const mode: AuthMode = searchParams.mode === "signup" ? "signup" : "login";
  const error = searchParams.error;
  const initialError = error
    ? error === "missing_code"
      ? "That sign-in link is missing its code. Request a new one."
      : error
    : null;

  return (
    <ScreenShell contentClassName="lg:flex-row">
      <aside
        className="relative hidden overflow-hidden p-14 lg:flex lg:w-[46%] lg:flex-col lg:justify-between"
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
          <h2 className="font-display text-6xl leading-[0.94] tracking-[0.005em] text-white">
            Every guest&apos;s
            <br />
            photos.
            <br />
            One live roll.
          </h2>
          <p className="mt-[22px] max-w-[440px] text-lg leading-[1.55] text-white/[0.92]">
            Create an event, share one link or QR, and watch the shots roll in
            as the night happens — no app for your guests, ever.
          </p>
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

        <Polaroid
          rotate={8}
          float
          dateStamp="07·05·26"
          padding="12px 12px 34px"
          className="absolute -right-10 top-[120px] w-[180px] shadow-[0_24px_50px_rgba(60,30,0,0.4)]"
        >
          <div
            className="h-[150px]"
            style={{ background: "linear-gradient(150deg,#17B7A6,#0c5b52)" }}
          />
        </Polaroid>
      </aside>

      <div className="flex flex-1 flex-col lg:items-center lg:justify-center lg:p-12">
        <SignInForm
          initialMode={mode}
          initialError={initialError}
          googleEnabled={process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === "true"}
        />
      </div>
    </ScreenShell>
  );
}

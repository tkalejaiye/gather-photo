import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { backButtonClasses } from "@/components/ui/back-button";
import { ScreenShell } from "@/components/ui/screen-shell";
import { CreateEventForm } from "./CreateEventForm";

export const metadata = { title: "New event · gather.photo" };

type Props = { searchParams: { error?: string } };

// Daylight screen 12. No desktop mock exists — per README §Target it's a
// simple centered ~440px column on the warm background at lg+.
export default async function NewEventPage({ searchParams }: Props) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  return (
    <ScreenShell contentClassName="lg:items-center lg:justify-center">
      <main className="mx-auto flex min-h-svh w-full max-w-[440px] flex-col px-[26px] pb-10 pt-[54px] lg:min-h-0 lg:flex-none lg:py-14">
        <Link
          href="/dashboard"
          aria-label="Back to your events"
          className={backButtonClasses("self-start")}
        >
          ←
        </Link>
        <CreateEventForm error={searchParams.error ?? null} />
      </main>
    </ScreenShell>
  );
}

import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignInForm } from "./SignInForm";

export const metadata = { title: "Sign in · gather.photo" };

type Props = {
  searchParams: { error?: string };
};

export default async function SignInPage({ searchParams }: Props) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  const error = searchParams.error;

  return (
    <main className="app-shell flex min-h-screen items-center px-6 py-10">
      <div className="mx-auto w-full max-w-md">
        <Link
          href="/"
          className="h-eyebrow inline-flex items-center gap-1 text-ink-300 transition hover:text-white"
        >
          ← gather.photo
        </Link>
        <div className="card mt-5">
          <p className="h-eyebrow">Hosts only</p>
          <h1 className="h-display mt-1 text-4xl">Sign in</h1>
          <p className="mt-3 text-sm text-ink-200">
            Guests don&apos;t need an account — they just open the event link.
          </p>
          {error && (
            <p className="banner-error mt-5" role="alert">
              {error === "missing_code"
                ? "That sign-in link is missing its code. Request a new one."
                : error}
            </p>
          )}
          <SignInForm />
        </div>
      </div>
    </main>
  );
}

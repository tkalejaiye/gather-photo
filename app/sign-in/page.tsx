import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignInForm } from "./SignInForm";

export const metadata = { title: "Sign in · gather.photo" };

export default async function SignInPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
      <h1 className="text-2xl font-semibold text-brand">Sign in</h1>
      <p className="mt-2 text-sm text-neutral-400">
        Hosts only. Guests don&apos;t need an account — they just open the event
        link.
      </p>
      <SignInForm />
    </main>
  );
}

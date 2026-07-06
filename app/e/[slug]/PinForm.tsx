import { redirect } from "next/navigation";
import { verifyEventPin } from "@/lib/events/actions";

// Server component + inline server action — no client JS shipped to the
// guest bundle. Critical path: keep this page tiny on slow Lagos networks.
export function PinForm({ slug }: { slug: string }) {
  async function submit(formData: FormData) {
    "use server";
    const pin = String(formData.get("pin") ?? "");
    const res = await verifyEventPin(slug, pin);
    if (!res.ok) {
      redirect(`/e/${slug}?error=${encodeURIComponent(res.error)}`);
    }
    redirect(`/e/${slug}`);
  }

  return (
    <form action={submit} className="space-y-4">
      <label className="block">
        <span className="field-label">PIN</span>
        <input
          name="pin"
          inputMode="numeric"
          autoComplete="off"
          required
          className="input mt-2 text-center text-lg tracking-[0.4em]"
          placeholder="••••"
        />
      </label>
      <button type="submit" className="btn-pop w-full">
        Unlock event →
      </button>
    </form>
  );
}

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
    <form action={submit} className="space-y-3">
      <label className="block">
        <span className="text-xs uppercase tracking-wide text-neutral-400">
          PIN
        </span>
        <input
          name="pin"
          inputMode="numeric"
          autoComplete="off"
          required
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
        />
      </label>
      <button
        type="submit"
        className="w-full rounded bg-brand px-4 py-2 text-sm font-medium text-white"
      >
        Continue
      </button>
    </form>
  );
}

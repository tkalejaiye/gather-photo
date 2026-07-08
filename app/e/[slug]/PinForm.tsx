import { redirect } from "next/navigation";
import { verifyEventPin } from "@/lib/events/actions";
import { Button } from "@/components/ui/button";

// Server component + inline server action — no client JS shipped to the
// guest bundle. Critical path: keep this page tiny on slow Lagos networks.
// FRI-34: Daylight restyle (tokens only — no mock exists for this screen).
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
        <span className="block text-center font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-daylight-muted">
          Event PIN
        </span>
        <input
          name="pin"
          inputMode="numeric"
          autoComplete="off"
          required
          placeholder="••••"
          className="mt-2 w-full rounded-daylight-field border border-daylight-rule bg-white/60 p-[15px] text-center font-mono text-xl font-bold tracking-[0.4em] text-daylight-ink outline-none transition focus:border-daylight-orange focus:shadow-daylight-focus"
        />
      </label>
      <Button type="submit" className="w-full">
        Unlock event
      </Button>
    </form>
  );
}

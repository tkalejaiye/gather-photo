// Host dashboard — gallery grid, counts, delete, ZIP download (M3).
// Requires auth (M0). Behind Supabase auth + RLS.

export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-brand">Your events</h1>
      <p className="mt-2 text-sm text-neutral-400">
        Stub. Host auth (M0), gallery + ZIP download (M3). See TECH_SPEC.md §6.
      </p>
    </main>
  );
}

// Guest upload route — the critical path.
// Keep this bundle TINY (loads on low-end Android over 3G).
// M1: capture/select → compress → single upload.
// M2: IndexedDB queue + resumable TUS + offline resume + progress UI.

export default function GuestUploadPage({
  params,
}: {
  params: { slug: string };
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold text-brand">Share your photos</h1>
      <p className="text-neutral-600">
        Event: <code className="rounded bg-neutral-100 px-1">{params.slug}</code>
      </p>
      <p className="text-sm text-neutral-400">
        Stub. Implement guest capture + offline-first upload here (TECH_SPEC.md §5).
      </p>
    </main>
  );
}

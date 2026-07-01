// Client-side single-shot upload for FRI-11.
//
// Two server hops + one storage PUT:
//   1. POST /api/uploads/sign        → { signedUrl, path, ... }
//   2. PUT  {signedUrl} <blob body>  → object lands in Supabase Storage
//   3. POST /api/uploads/register    → media row created
//
// Resumable + offline-queueing is FRI-12/FRI-13/FRI-14 (M2). This module is
// deliberately tiny so it can be dynamically imported from the guest page
// without inflating the initial chunk (TECH_SPEC §8 bundle budget).

import type { CompressResult } from "@/lib/image/compress";

export interface DirectUploadInput {
  slug: string;
  uploaderToken: string;
  uploaderName: string | null;
  compressed: CompressResult;
  contentType: string;
  onProgress?: (fraction: number) => void;
}

export type DirectUploadResult =
  | { ok: true; mediaId: string | null; duplicate: boolean }
  | { ok: false; error: string };

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (${res.status})`;
}

export async function directUpload(input: DirectUploadInput): Promise<DirectUploadResult> {
  const { slug, uploaderToken, uploaderName, compressed, contentType, onProgress } = input;
  onProgress?.(0);

  // 1. Ask the server for a signed upload URL scoped to this event.
  const signRes = await fetch("/api/uploads/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, contentType }),
  });
  if (!signRes.ok) return { ok: false, error: await readError(signRes) };
  const sign = (await signRes.json()) as { signedUrl?: string; path?: string };
  if (!sign.signedUrl || !sign.path) {
    return { ok: false, error: "Sign response missing fields." };
  }

  // 2. PUT the compressed blob directly to Supabase Storage. Using XHR
  // (not fetch) so we can surface per-file progress — fetch has no progress
  // event in browsers. Tiny wrapper, no extra deps.
  const putOk = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sign.signedUrl!, true);
    xhr.setRequestHeader("Content-Type", contentType);
    // Supabase's signed upload URL accepts `x-upsert: true` to overwrite —
    // we set it so a retry of the same path doesn't fail with "already exists".
    xhr.setRequestHeader("x-upsert", "true");
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true });
      else resolve({ ok: false, error: `Storage upload failed (${xhr.status})` });
    };
    xhr.onerror = () => resolve({ ok: false, error: "Network error during upload." });
    xhr.send(compressed.blob);
  });
  if (!putOk.ok) return { ok: false, error: putOk.error ?? "Upload failed." };
  onProgress?.(1);

  // 3. Register the media row.
  const regRes = await fetch("/api/uploads/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug,
      path: sign.path,
      bytes: compressed.blob.size,
      width: compressed.width,
      height: compressed.height,
      contentHash: compressed.contentHash,
      uploaderToken,
      uploaderName,
    }),
  });
  if (!regRes.ok) return { ok: false, error: await readError(regRes) };
  const reg = (await regRes.json()) as { mediaId: string | null; duplicate: boolean };
  return { ok: true, mediaId: reg.mediaId, duplicate: !!reg.duplicate };
}

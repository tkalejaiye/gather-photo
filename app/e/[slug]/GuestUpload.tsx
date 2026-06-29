"use client";

import { useEffect, useId, useRef, useState } from "react";

// Guest upload UX. FRI-9 shipped the shell (name + pick); FRI-11 wires the
// end-to-end happy path: compress → sign → PUT → register. The IndexedDB
// queue + TUS resumable land in M2 (FRI-12/FRI-13/FRI-14).
//
// Critical-path constraints (TECH_SPEC §5, §8):
// - Bundle stays tiny — heavy deps (browser-image-compression, the upload
//   helper) are dynamically imported inside the click handler so they
//   never enter the initial chunk.
// - No upload is started until the guest taps "Upload" — bandwidth is
//   precious on a saturated venue Wi-Fi, and accidental picks shouldn't
//   spend it.

const TOKEN_KEY = "gp_uploader_token";
const NAME_KEY = "gp_uploader_name";

type UploadPhase =
  | { kind: "idle" }
  | { kind: "compressing" }
  | { kind: "uploading"; progress: number }
  | { kind: "done"; duplicate: boolean }
  | { kind: "failed"; error: string };

type Picked = { id: string; file: File; phase: UploadPhase };

// `crypto.randomUUID()` requires a secure context and is missing from older
// Android WebViews / Transsion stock browsers (PRD §8). Fall back to a v4
// UUID built from `getRandomValues`, which has much wider support.
function newUuid(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // fall through to manual v4
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode / quota — best-effort, fall through
  }
}

function removeLocal(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // best-effort
  }
}

export function GuestUpload({ slug }: { slug: string }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const nameInputId = useId();

  useEffect(() => {
    // Token must survive reloads so M1 can attribute uploaded media to one
    // guest across sessions (TECH_SPEC §5). Try to persist on every path.
    let token = readLocal(TOKEN_KEY);
    if (!token) {
      token = newUuid();
      writeLocal(TOKEN_KEY, token);
    }
    tokenRef.current = token;
    const stored = readLocal(NAME_KEY);
    if (stored) setName(stored);
  }, []);

  function onNameChange(value: string) {
    setName(value);
    if (value) writeLocal(NAME_KEY, value);
    else removeLocal(NAME_KEY);
  }

  function onFilesPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const fresh = Array.from(event.target.files ?? []);
    // Reset the input so picking the same file again still fires onChange.
    event.target.value = "";
    if (fresh.length === 0) return;
    setPicked((prev) => [
      ...prev,
      ...fresh.map((file) => ({
        id: newUuid(),
        file,
        phase: { kind: "idle" as const },
      })),
    ]);
  }

  function removePicked(id: string) {
    setPicked((prev) => prev.filter((p) => p.id !== id));
  }

  function setItemPhase(id: string, phase: UploadPhase) {
    setPicked((prev) => prev.map((p) => (p.id === id ? { ...p, phase } : p)));
  }

  async function startUploads() {
    if (busy) return;
    const pending = picked.filter(
      (p) => p.phase.kind === "idle" || p.phase.kind === "failed",
    );
    if (pending.length === 0) return;
    setBusy(true);
    try {
      // Dynamic imports keep the heavy compression lib + xhr helper out of
      // the initial guest chunk. They only enter the network the first time
      // a guest actually decides to upload.
      const [{ compress }, { directUpload }] = await Promise.all([
        import("@/lib/image/compress"),
        import("@/lib/upload/direct"),
      ]);
      const uploaderToken = tokenRef.current ?? "";
      const uploaderName = name.trim() ? name.trim() : null;

      for (const item of pending) {
        setItemPhase(item.id, { kind: "compressing" });
        let compressed;
        try {
          compressed = await compress(item.file);
        } catch (err) {
          setItemPhase(item.id, {
            kind: "failed",
            error: err instanceof Error ? err.message : "Could not process photo.",
          });
          continue;
        }
        setItemPhase(item.id, { kind: "uploading", progress: 0 });
        const result = await directUpload({
          slug,
          uploaderToken,
          uploaderName,
          compressed,
          contentType: compressed.blob.type || item.file.type || "image/jpeg",
          onProgress: (fraction) =>
            setItemPhase(item.id, { kind: "uploading", progress: fraction }),
        });
        if (result.ok) {
          setItemPhase(item.id, {
            kind: "done",
            duplicate: result.duplicate,
          });
        } else {
          setItemPhase(item.id, { kind: "failed", error: result.error });
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const pendingCount = picked.filter(
    (p) => p.phase.kind === "idle" || p.phase.kind === "failed",
  ).length;

  return (
    <div className="w-full space-y-5" data-slug={slug}>
      <label htmlFor={nameInputId} className="block">
        <span className="text-xs uppercase tracking-wide text-neutral-400">
          Your name (optional)
        </span>
        <input
          id={nameInputId}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="So the host knows it was you"
          autoComplete="name"
          maxLength={60}
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block w-full cursor-pointer rounded bg-brand px-4 py-3 text-center text-sm font-medium text-white">
            Take photo
          </span>
          <input
            type="file"
            accept="image/*"
            // `capture` is a hint; on desktop the file picker still works.
            capture="environment"
            onChange={onFilesPicked}
            className="sr-only"
          />
        </label>

        <label className="block">
          <span className="block w-full cursor-pointer rounded border border-neutral-700 px-4 py-3 text-center text-sm font-medium text-neutral-100">
            Choose photos
          </span>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={onFilesPicked}
            className="sr-only"
          />
        </label>
      </div>

      {picked.length > 0 ? (
        <>
          <ul aria-label="Selected photos" className="space-y-2 text-left">
            {picked.map(({ id, file, phase }) => (
              <li
                key={id}
                className="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-neutral-200">
                  {file.name}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {formatBytes(file.size)}
                </span>
                <PhaseBadge phase={phase} />
                {phase.kind === "idle" || phase.kind === "failed" ? (
                  <button
                    type="button"
                    onClick={() => removePicked(id)}
                    aria-label={`Remove ${file.name}`}
                    className="shrink-0 rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-100"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={startUploads}
            disabled={busy || pendingCount === 0}
            className="w-full rounded bg-brand px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy
              ? "Uploading…"
              : pendingCount > 0
                ? `Upload ${pendingCount} photo${pendingCount === 1 ? "" : "s"}`
                : "All uploaded"}
          </button>
        </>
      ) : (
        <p className="text-sm text-neutral-500">No photos selected yet.</p>
      )}
    </div>
  );
}

function PhaseBadge({ phase }: { phase: UploadPhase }) {
  switch (phase.kind) {
    case "idle":
      return null;
    case "compressing":
      return <span className="shrink-0 text-xs text-neutral-400">Preparing…</span>;
    case "uploading":
      return (
        <span className="shrink-0 text-xs text-neutral-300">
          {Math.round(phase.progress * 100)}%
        </span>
      );
    case "done":
      return (
        <span className="shrink-0 text-xs text-emerald-400">
          {phase.duplicate ? "Already added" : "Uploaded"}
        </span>
      );
    case "failed":
      return (
        <span
          className="shrink-0 text-xs text-red-400"
          title={phase.error}
        >
          Failed
        </span>
      );
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

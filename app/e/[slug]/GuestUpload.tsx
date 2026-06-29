"use client";

import { useEffect, useId, useRef, useState } from "react";

// Shell for the guest upload UX (FRI-9). Holds picked File objects in
// component state only — no compression, no IndexedDB, no network. M1/M2
// will read this list, compress, enqueue, and drain via TUS.
//
// Keep this client component small: it ships on the critical path on
// low-end Android over 3G (TECH_SPEC.md §5, §8).

const TOKEN_KEY = "gp_uploader_token";
const NAME_KEY = "gp_uploader_name";

type Picked = { id: string; file: File };

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
      ...fresh.map((file) => ({ id: newUuid(), file })),
    ]);
  }

  function removePicked(id: string) {
    setPicked((prev) => prev.filter((p) => p.id !== id));
  }

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
        <ul
          aria-label="Selected photos"
          className="space-y-2 text-left"
        >
          {picked.map(({ id, file }) => (
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
              <button
                type="button"
                onClick={() => removePicked(id)}
                aria-label={`Remove ${file.name}`}
                className="shrink-0 rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-100"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-500">
          No photos selected yet.
        </p>
      )}

      <p className="text-xs text-neutral-500">
        Picked photos stay in this tab for now. Compression + offline upload
        land in M1/M2.
      </p>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

# gather.photo — Technical Spec (MVP)

**Companion doc:** `PRD.md` (product requirements). This doc is the engineering source of truth.
**Prime directive:** a guest scans a QR code, captures/picks photos, and they reliably reach the host's gallery **even on a congested venue network.** Everything else is secondary.

---

## 1. Scope

**In:** host auth + event creation; QR/link; no-login guest upload with client-side compression, offline IndexedDB queue, and resumable (TUS) uploads; host gallery (view, delete, ZIP download); Paystack checkout; WhatsApp share; installable PWA.

**Out (MVP):** native apps, App Clips, video transcoding, AI face-find, audio guestbook, live slideshow, sub-albums, custom branding, guest social feed.

**Video decision:** photos-first. If video ships, store raw + play back natively (no transcoding), hard cap (≤100 MB / 60s). Otherwise defer. Video is the #1 cost/complexity sink.

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js (App Router) PWA, TypeScript, Tailwind | SSR landing for SEO; service worker for offline shell |
| Upload queue | IndexedDB (`idb`) | Persists blobs across reconnects/tab close |
| Resumable upload | `tus-js-client` → Supabase Storage (TUS) | Native resumable support in Supabase Storage |
| Compression | `browser-image-compression` | Downscale + re-encode before upload |
| Backend/DB/Auth | Supabase (Postgres + Auth + Storage + RLS) | Minimal backend code |
| Object storage | Supabase Storage (MVP) → Cloudflare R2 (scale) | R2 = no egress fees |
| Payments | Paystack | Card/Verve, bank transfer, USSD |
| QR | `qrcode` | Trivial |
| ZIP | `archiver` streamed over signed URLs | Don't buffer whole gallery |
| Hosting | Vercel + Supabase + Cloudflare CDN on media | Pick Supabase region nearest Lagos (EU-West) |

## 3. Architecture

```
Guest PWA: capture/select → compress → enqueue (IndexedDB)
           → background uploader ──TUS──▶ Supabase Storage (resumable, retried)
                                              └─▶ register media row (server)
Host PWA:  Postgres (events/media/payments) via RLS
           "Download all" → Next.js route → stream ZIP of signed URLs
Paystack ──webhook──▶ Next.js route → mark paid / activate event (idempotent)
```

## 4. Data model

See `supabase/migrations/0001_init.sql` for the authoritative schema. Tables: `profiles` (hosts), `events` (slug, pin, tier, windows, status), `media` (event_id, uploader_token/name, storage_path, kind, bytes, content_hash, status), `payments` (paystack_ref, amount_kobo, channel, status). RLS isolates hosts to their own rows; guests never read the DB directly.

## 5. Critical path — offline-first guest upload (build & test first)

Flow: open `/e/{slug}` (+optional PIN) → PWA shell from SW cache → store `uploader_token` + name in localStorage → capture/select → **compress** (≈2048px long edge, ~0.8 quality, fix EXIF orientation, HEIC→JPEG) → hash → **enqueue in IndexedDB** → background uploader drains queue via **TUS resumable** with exponential backoff, pausing/resuming on connectivity changes → on success register `media` row → UI shows per-item (queued/uploading%/done/failed) + overall progress.

Module contracts (see `lib/`): `image/compress.ts` `compress(file) → Blob`; `upload/queue.ts` IndexedDB CRUD over queue items; `upload/uploader.ts` `drainQueue()` triggered on load + `online` event + Background Sync where available.

**Verification (the real acceptance test):** at an actual large event on a saturated network, ≥90% of started uploads complete within the window without the guest babysitting the screen. Plus: unit tests for compression output size/orientation; an integration test that simulates network drop mid-upload and asserts resume.

## 6. Host flow

Sign up (email/phone OTP) → create event (name/date/PIN/tier) → pay (Paystack) → event `active`, windows set → get QR + link, one-tap WhatsApp share, printable QR card → dashboard: grid, counts, filter by uploader, delete, Download-all ZIP.

## 7. Paystack integration

`POST /api/pay/init` creates a `pending` payment + returns Paystack auth URL (channels: card, bank_transfer, ussd; amount in kobo). `POST /api/pay/webhook` is the source of truth: verify signature, mark `success`, set `events.paid`, `status='active'`, compute expiry — **idempotent** by `paystack_ref`. `GET /api/pay/verify` optional client double-check. Secrets server-side only.

**Verification:** webhook signature test; idempotency test (same ref twice → one activation); sandbox end-to-end with Paystack test keys.

## 8. Non-functional requirements

Tiny guest bundle, fast on low-end Android/3G · compression on by default · **guest uploads run serially (one at a time), `DEFAULT_IN_FLIGHT_CAP = 1`** — parallel TUS streams reliably stall on iOS Safari (§10); a photo uploads in seconds, so throughput cost is negligible · no silent upload failures: the guest sees the actual error text and can retry · installable PWA + offline shell · log upload success rate / time-to-complete / failure-by-network-type (these are the validation metrics) · test matrix includes low-end Android **and iOS Safari** + throttled/lossy network as a first-class gate.

**Bundle budget — `/e/[slug]` First Load JS ≤ 110 kB** (Next 14 `next build` "First Load JS" column, includes the shared framework chunks). Heavy guest-only deps (`browser-image-compression`, `tus-js-client`, `idb`) must be **dynamically imported** inside event handlers or lazy effects so they don't land in the initial chunk. Check `next build` output on every PR that touches `app/e/[slug]/` or shared chunks; a regression past the budget blocks merge.

## 9. Security & privacy

Private by unguessable slug (+ optional PIN); no listing. **Guest uploads go directly to Supabase Storage over the TUS endpoint** using the public anon key (`authorization` + `apikey` headers) plus `x-upsert` (so a resumed upload can PATCH an existing chunk without 409-ing). A **Storage RLS policy (`supabase/migrations/0003_storage_rls.sql`) gates those writes to `events/{event_id}/…` under an active, unexpired event** — the abuse surface is bounded by Storage RLS + Supabase, not an app endpoint (this is why the old `/api/uploads/sign` route was removed). Once the object lands, the guest calls `POST /api/uploads/register` (**rate-limited** by IP + uploader token; **idempotent** by `(event_id, content_hash)`) to insert the `media` row; guests never query the DB directly. Media reads via short-lived signed URLs; bulk download host-only. RLS on every table. Honor `storage_expires_at` via scheduled cleanup. Host can delete any item.

## 10. Edge cases

HEIC/HEIF → JPEG client-side · bake EXIF orientation in during compression · dedupe via `content_hash` unique per event · **compressed bytes are stored in IndexedDB as a raw `ArrayBuffer`, not a Blob/File** — iOS Safari file-backs Blobs pulled from IDB and its fetch layer then refuses to send them as a TUS PATCH body (uploads stick at 0%); the uploader reconstructs a fresh in-memory Blob at upload time · tab closed / reloaded mid-upload → queue persists and resumes from the saved `tusUploadUrl`, and **stranded `uploading` rows are reclaimed on the next drain** (otherwise they hold an in-flight slot and starve the queue — the "photos stuck" symptom) · **serial uploads (in-flight cap = 1)** — parallel TUS streams stall on iOS Safari; free the `data` bytes after success · webhook/callback ordering → idempotent activation · large ZIPs → stream / chunk · anonymous guest allowed (attribute by token).

## 11. Build milestones

| # | Milestone | Deliverable |
|---|---|---|
| M0 | Foundations | Repo, Next.js PWA shell, Supabase wiring, auth, create-event, QR + link |
| M1 | Guest happy path | Capture/select → compress → single direct upload → appears in gallery |
| **M2** | **Offline queue + resumable** | IndexedDB queue, TUS resumable, retry/backoff, status UI (the hard core) |
| M3 | Host gallery | Grid, counts, delete, ZIP download |
| M4 | Payments | Paystack init + webhook + tiers + activation |
| M5 | Polish + Lagos hardening | PWA install, WhatsApp share, low-end/throttled testing, printable QR |

M0–M3 is enough to run the real-event validation test (collect payment manually). M4 follows once demand is shown.

## 12. Definition of Done (every issue)

Code + tests for the issue's acceptance criteria · `npm run build`, `lint`, `typecheck`, and tests pass · verification evidence shown (test output / screenshot) · adversarial diff review (fresh-context subagent / `/code-review`) against this spec · PR opened with a descriptive message linking the Linear issue.

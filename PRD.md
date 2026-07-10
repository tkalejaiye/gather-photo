# gather.photo — Product Requirements (MVP)

**Status:** Draft v1 · **Owner:** Tolu / Fringeworks · **Last updated:** June 2026
**Companion doc:** see `TECH_SPEC.md` for the engineering design.

---

## 1. Problem

At large social events — especially Lagos weddings ("owambe") with 500–1,000+ guests — hundreds of people capture photos and videos on their phones, but there is no easy, reliable way to gather them in one place. The host ends up chasing photos across WhatsApp groups, DMs, and Google Drive links, and most images are never collected. The moments captured from the guests' perspective are lost.

## 2. Vision

One link / QR code per event. Any guest scans it, and their photos reliably land in the host's private gallery — no app install, no login — even when the venue's network is congested. The host gets every angle of their event in one place and can download it all.

## 3. Target user

- **Primary buyer:** the host of a premium Lagos event — typically a couple (or their planner/photographer) for a wedding. Skews higher-income, mixed-device but often iPhone.
- **Primary users (uploaders):** all event guests. **Always a mixed-device crowd** (heavily Android/Transsion in Nigeria) — this is why the guest experience must be web-first and cross-platform.
- **Key channel partner:** wedding photographers and planners (repeat buyers; our best distribution).

## 4. Goals & success metrics (MVP)

The MVP exists to answer one question: *will guests actually upload, and will hosts pay?*

| Goal | Metric | Target (validation) |
|---|---|---|
| Guests actually contribute | % of started uploads that complete | ≥ 90% within the upload window |
| The flow works under real conditions | Uploads survive a congested venue network | Proven at ≥1 real large event |
| Hosts find it valuable | Host says they would pay / recommend | Qualitative yes from ≥3 hosts |
| Acquisition is viable | Cost per host signup (later) | Well under plausible price |

## 5. Non-goals (explicitly out of scope for MVP)

Native iOS/Android apps · iOS App Clips · video transcoding/streaming · AI face-find · audio guestbook · live slideshow · multi-gallery/sub-albums · custom branding/white-label · guest social feed (likes/comments). These are post-validation considerations, tracked separately.

## 6. User stories

**Host**
- As a host, I can sign up and create an event (name, date, optional PIN) so I have a private gallery.
- As a host, I can pay once (in naira) to activate my event.
- As a host, I get a QR code and a shareable link, and can share it to WhatsApp in one tap.
- As a host, I can view all uploaded photos, delete unwanted ones, and download everything as a ZIP.

**Guest**
- As a guest, I can open the event link with no app and no login.
- As a guest, I can take or select photos and have them upload reliably, with clear per-photo progress.
- As a guest, if my connection drops or I close the tab, my queued photos resume uploading later.
- As a guest, I can optionally add my name so the host knows who contributed.

## 7. Functional requirements

1. **Event creation** — host auth (email magic link + Google OAuth), create event, unguessable slug, optional PIN, upload window + storage expiry.
2. **Guest upload (critical path)** — no-login web page; camera capture or multi-select; **client-side compression**; **offline-first queue (IndexedDB)**; **resumable uploads (TUS)** with retry/backoff; visible per-item + overall progress.
3. **Host gallery** — grid view, uploader attribution, delete/moderation with a **pending → host-approved review queue** (uploads stay hidden from any guest-facing surface until approved; per-event auto-approve opt-out), **one-click ZIP download** in original (uploaded) quality.
4. **Payments** — Paystack checkout in naira (card/Verve, bank transfer, USSD); webhook-confirmed activation; tiered by guest band.
5. **Sharing** — QR code generation + printable card; WhatsApp share link.
6. **Privacy** — private by unguessable slug (+ optional PIN); signed URLs; host-only bulk download; scheduled expiry cleanup.

## 8. Constraints (Lagos)

- **Congested venue networks** → offline + resumable uploads are mandatory, not optional.
- **~91% Android, mostly low-end Transsion** → web-first, tiny bundle, no iOS-only APIs; must run on a cheap Android over a slow network.
- **Cheap data (~$0.38/GB) but slow networks** → compress for speed, not to save the guest money.
- **Local payments** → Paystack, priced in naira.
- **Sharing lives on WhatsApp** → share = WhatsApp link.

## 9. Pricing (illustrative — validate in market)

One-time per event, priced in naira, tiered by guest band (Lite / Standard / Premium). Frame against the wedding/photography budget, not "an app." Plan a photographer/planner reseller price. Final numbers set after the demand test.

## 10. Release / validation plan

Ship through gallery + download (no payments yet), run at 2–5 real events charging manually, measure the metrics in §4, then decide go / iterate / pass. See `TECH_SPEC.md` §11 for build milestones (M0–M5).

## 11. Open questions

1. Video in MVP? (Recommend no, or raw + hard cap.)
2. Guests view the gallery, or host-only? **Decided (FRI-30/FRI-37): guests will get a shared gallery showing host-approved photos only** — approval shipped first so the guest view inherits a safe default.
3. Sell to couples or photographers first? (Recommend a vendor-friendly model early.)
4. Final pricing tiers (after demand test).

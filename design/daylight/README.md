# Handoff: Gather.photo — "Daylight" direction

## Overview
Gather.photo is an event photo-sharing app. A **host** creates an event and shares a link/QR; **guests** open that link and drop their photos into one shared, live "roll" — with **no app install and no guest login**. This package covers the full guest flow plus host onboarding (auth) and the host dashboard, in the chosen visual direction, **"Daylight"**: a warm, playful, disposable-camera / film-paper aesthetic (light mode).

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes that show the intended look, layout, and behavior. They are **not production code to copy directly.** They are built as "Design Components" (`.dc.html`) and depend on a small runtime (`support.js`) and a device-frame helper (`ios-frame.jsx`) purely so they render in the design tool.

Your task is to **recreate these designs in the target codebase's environment** (React, Vue, SwiftUI, native, etc.) using its established patterns, component library, and conventions. If there is no existing environment yet, choose the most appropriate framework for a mobile-first PWA (the intent here is a **Progressive Web App** that works on phones and full-screen desktop) and implement there. Do not ship the HTML directly, and do not treat `support.js` / `ios-frame.jsx` / the `.dc.html` wrappers as things to port — they are scaffolding.

## Fidelity
**High-fidelity (hifi).** Colors, typography, spacing, radii, and interactions are final and intentional. Recreate the UI pixel-faithfully using the codebase's libraries. The one caveat: photos are represented by CSS gradient placeholders — real images replace them.

## Target & Responsive Intent
- **PWA, mobile-first**, but must also look intentional full-screen on desktop.
- **Mobile** layouts are the source of truth for the guest flow — see `Gather Daylight.dc.html` (390×844 reference, iPhone-class).
- **Desktop** layouts are provided as anchors for the three screens whose layout genuinely changes — see `Gather Daylight Desktop.dc.html` (1360px-wide reference frames).
- Screens **not** given a desktop mock (Name, Uploading, Success, Check-email, Create-event) are simple centered cards: on desktop, constrain to ~`max-width: 440px`, center vertically and horizontally on the warm background. No new layout needed.

---

## Design Tokens

### Colors
| Token | Hex | Use |
|---|---|---|
| Paper (bg) | `#F4E9CE` | App background (light film paper) |
| Paper edge | `#ded1b6` / `#d3c4a6` | Outer/ambient background, gradients |
| Ink | `#241a0c` | Primary text, dark surfaces (sidebar, lightbox) |
| Ink-soft | `#6b5c3a` | Body text |
| Muted | `#8a7a56` | Secondary/label text |
| Rule/border | `#d8c49a` (`#e2d3b2` lighter) | Card borders, dividers, inputs |
| **Orange (primary)** | `#FF6A00` | Primary brand accent |
| Orange gradient | `linear-gradient(135deg, #FF8A1E 0%, #FF5A00 100%)` | Primary buttons, avatars, active chips |
| Orange deep | `#c85a12` / `#e24e00` | Eyebrow labels, gradient tail |
| Teal | `#17B7A6` → `#0c5b52` | Secondary photo/accent |
| Red | `#E8503B` → `#8a1c12` | Likes (active heart), photo accent |
| Yellow | `#E9C33C` → `#a3791c` | Photo accent |
| Date stamp (on photo) | `#FFD9A8` | Film-style date text over images |
| White | `#ffffff` | Photo print borders, cards, Google button |

Photo placeholder gradients (rotate through this set):
`#F5852A→#a34a12`, `#17B7A6→#0c5b52`, `#E8503B→#8a1c12`, `#E9C33C→#a3791c`, `#3FA7A0→#0e4a44`, `#D96A2B→#8a3a10`, `#F0A83C→#a3791c`, `#C98A3A→#6e3d12` (all `linear-gradient(150deg, …)`).

### Typography
- **Display / headings:** `Archivo Black` (single weight 900). Used uppercase for hero titles, screen titles, stat numbers, button labels. `letter-spacing: 0.005em`, `line-height: 0.88–0.95` on large sizes.
- **UI mono / labels:** `Space Mono` (400/700). Eyebrow labels (uppercase, `letter-spacing: 0.16em`), date stamps, meta, chips, link URLs.
- **Body / inputs:** `Archivo` (400–800). Paragraphs, input text, secondary buttons.
- Sizes (mobile): hero H1 54px; screen H1 34px; body 15–16px; labels 11–12px. Desktop: brand hero 60px; screen titles 36–40px; body 15–18px. Never below 11px.

### Spacing / Radius / Shadow
- Screen padding: mobile ~26px horizontal; desktop frames 32–56px.
- Radius: buttons/inputs `13–14px`; cards `16–18px`; chips `9px`; photo prints `2–4px` inner / white frame; avatars & FAB `50%`.
- Primary shadow: `0 12px 28px rgba(255,106,0,0.38)` (orange buttons). Cards: `0 6–14px … rgba(90,70,30,0.12–0.2)`. Photo prints: `0 6–8px … rgba(90,70,30,0.16–0.2)`.
- Photo "print" motif: white card `background:#fff; padding:6–9px 6–9px 8–24px` (extra bottom padding = polaroid chin) around a gradient image; slight `rotate()` on hero/lightbox for hand-placed feel.

---

## Screens / Views

### Guest flow (mobile — `Gather Daylight.dc.html`)

**1. Landing** — guest lands from the event link.
- Layout: full-height column, 84px top / 44px bottom padding. Live eyebrow ("● ROLL 01 · LIVE", blinking dot) → centered block (uppercase hero title "LAKE HOUSE'26" with orange apostrophe-year, date range, one-line description, a floating cluster of 3 tilted polaroids, a bordered "◉ 132 SHOTS IN THE ROLL" pill) → footer button stack.
- Buttons: primary orange-gradient **"◉ Add your shots"**; secondary paper **"SEE THE ROLL →"**; text **"Hosting this event? Manage →"** (routes to Log in).
- Polaroids gently float (`gp-float`, 5.5s, staggered).

**2. Name** — guest identifies themselves (no account).
- Centered: 96px rounded-square avatar showing the initial (orange gradient), eyebrow "ONE QUICK THING", H1 "What's your name?", subtitle, centered text input. Footer **Continue** button, disabled (opacity .5, ink-8% bg) until a name is entered.

**3. Upload picker** — choose shots.
- Header row: back arrow (left) + "Hi, {name}". Eyebrow + H1 "Pick your shots". Two large square tiles: **Take a photo** (orange gradient) and **Library** (paper). Bottom: "Selected / N ready" + horizontal tray of polaroid thumbnails. Footer **"Add N shots"**.

**4. Uploading** — progress.
- Centered spinning ring (orange, `gp-spin` .9s) with live **%** in the middle, H1 "Adding your shots…", subtitle, and a linear progress bar. Auto-advances to Success at 100%.

**5. Success** — confirmation.
- Centered orange-gradient check badge (pops in, `gp-pop`), H1 "You're in the roll!", subtitle with count. Buttons: **See the roll** (primary), **ADD MORE** (secondary).

**6. Gallery ("The Roll")** — the shared feed.
- Sticky header (blurred paper): back arrow **on the left**, then event eyebrow + uppercase H1 "The Roll"; filter chips row **ALL 132 / YOURS / ♥ LIKED** (active = orange gradient, else paper). 2-column CSS masonry of polaroid cards; each = white print, gradient image with bottom scrim + date stamp, then a row of uploader name (Space Mono) + ♥ like count (red when liked). Fixed circular orange **+** FAB bottom-right → Upload.

**7. Photo viewer (overlay)** — mobile takeover.
- Full-screen paper overlay. Top: ✕ (left) + uploader avatar/name. Center: large tilted polaroid of the photo with date stamp. Bottom: **♥ Like** button (fills orange + increments when liked) + a download square.

### Host flow

**8. Welcome (auth gate)** — first screen of the app (host side is gated).
- Wordmark "GATHER.PHOTO", floating polaroids, hero H1 "Every guest's photos. / One live roll." (second line orange), pitch. Buttons: **Create host account** (primary), **LOG IN** (secondary).

**9. Sign up** — create account. Back arrow (left). Eyebrow "CREATE ACCOUNT", H1 "Start hosting". **Continue with Google** (white, multicolor G svg), "or" divider, **Name** + **Email** inputs, primary **"Email me a magic link"** (disabled until name present AND email matches `/\S+@\S+\.\S+/`). Footer toggle "Already hosting? **Log in**".

**10. Log in** — returning host. Same as Sign up minus the name field; email only. Footer toggle "New here? **Create account**".

**11. Check your email** — magic-link interstitial. Back arrow. Centered envelope icon in a rounded paper tile, H1 "Check your email", subtitle naming the address. Primary **"◉ I opened the link"** (simulates the click → continues), text link "Resend or change email".

**12. Create your first event** — Eyebrow "NEW EVENT", H1 "Create your event". **Live cover preview** card (selected gradient + event name overlaid). **Event name** input, **Dates** field (display-only in mock: "Jul 4 – Jul 7, 2026"), **Cover** color picker (4 gradient swatches, selected = double ring `0 0 0 3px #F4E9CE, 0 0 0 5px #FF6A00`). Primary **"Create event & get link"** (disabled until name present) → Host dashboard.

**13. Host dashboard ("Roll Control")** — Back arrow (exits to Welcome). Eyebrow, uppercase H1 "Lake House '26", "Live · closes Jul 8". **Share card**: QR (rendered as an 11×11 CSS grid) + "GUEST LINK" + `gather.photo/lake26` + **Copy link** button (label → "Copied ✓" for 1.6s). Three **stat cards** (SHOTS 132 / CROWD 38 / LOOKS 1.2k). **Moderate** section: 3-col grid; tap a tile to toggle a "Hidden" overlay. Footer: **VIEW LIVE ROLL** + text "Preview guest view →".

### Desktop anchors (`Gather Daylight Desktop.dc.html`)
Each frame is shown inside browser chrome (traffic lights + URL pill) — that chrome is illustrative, not part of the app.

- **D1 · Auth (split screen):** left ~46% is a full-bleed orange-gradient brand panel (wordmark top, 60px hero headline, pitch, two proof stats, a floating polaroid bleeding off the right edge); right ~54% is a centered form card (max-width 400px) identical in content to the mobile Sign up. On narrow widths this collapses to the mobile stack (brand panel becomes a short top banner or is dropped).
- **D2 · Gallery:** persistent top nav (wordmark · live event name · filter chips · **+ Add photos** · avatar) over a **5-column** masonry (`column-count:5; column-gap:16px`). Sub-header: date/guest eyebrow + 40px "THE ROLL" + count. Scale columns down with width (5→4→3→2).
- **D3 · Lightbox:** replaces the mobile full-screen viewer. Dark scrim (`rgba(24,16,6,0.82)`) over a blurred hint of the gallery; centered large polaroid (~520×640) with ‹ › nav circles and a top-right ✕; a 340px **detail rail** on the right (uploader avatar/name/time, "SHOT 3 OF 132", big like count, **♥ Like** + download, and a thumbnail filmstrip with the active thumb ringed).
- **D4 · Host dashboard:** dark left **sidebar** (244px: wordmark, nav items with Overview active in orange gradient, current-event card pinned bottom) + main content: live eyebrow + 38px title + **View live roll ↗**; two-pane body = left 320px column (share card with large QR, link, Copy button; then a 3-up stat row) and right pane (paper card, "Recent uploads", 4-col moderation grid of prints with uploader names).

---

## Interactions & Behavior
- **Guest routing:** Landing → (name known? Upload : Name) → Upload → Uploading (auto) → Success → Gallery. Gallery ↔ Viewer; FAB → Upload.
- **Host gate:** app boots to **Welcome**. Welcome → Sign up / Log in → (Google shortcut, or magic link → Check email → "I opened the link") → **Sign up path lands on Create event; Log in path lands on Host dashboard.** Create event → Host dashboard.
- **Gallery filters:** ALL / YOURS (mine) / LIKED (client-side filter of the photo list). Active chip = orange gradient.
- **Like:** toggles per-photo; increments the displayed count by 1 and turns the heart red (`#E8503B`) while active.
- **Moderation hide:** toggles a translucent "Hidden" overlay on the tile.
- **Copy link:** button label swaps to "Copied ✓" for 1.6s.
- **Validation:** name non-empty; email `/\S+@\S+\.\S+/`; event name non-empty. Disabled buttons drop to opacity .5 with a flat ink-8% background and no shadow.
- **Animations:** `gp-fade` (screen enter, .3–.4s), `gp-pop` (success check), `gp-spin` (uploader ring), `gp-float` (polaroids), `gp-blink` (live dots, input caret). Buttons scale to ~.96 on `:active`.

## State Management
Guest: `screen`, `nickname`, `progress`, `filter` (all|mine|liked), `viewerId`, `liked{}` (id→bool), `hidden{}` (id→bool), `copied`.
Host/auth: `authMode` (signup|login), `authName`, `authEmail`, `sentTo`, `eventName`, `eventCover` (index).
Data fetching (real app): event by slug, photo list (paginated, newest-first), like/hide mutations, magic-link + Google OAuth, event creation returning the guest slug/QR.

## Assets
- **Fonts:** Archivo Black, Space Mono, Archivo — Google Fonts.
- **Google "G" logo:** inline multicolor SVG in the auth screens (replace with the codebase's standard OAuth button if one exists).
- **QR code:** a decorative CSS-grid placeholder in the mocks — generate a **real** QR for the guest URL in production.
- **Photos:** gradient placeholders throughout — replace with real uploaded images (object-fit: cover inside the white print frame).
- No raster brand assets; the wordmark is set type ("GATHER.PHOTO", Archivo Black, "." in orange).

## Files
- `Gather Daylight.dc.html` — full interactive **mobile** flow (all 13 screens + viewer).
- `Gather Daylight Desktop.dc.html` — **desktop** anchor frames D1–D4 (Auth, Gallery, Lightbox, Host).
- `ios-frame.jsx`, `support.js` — design-tool scaffolding only; **do not port.**

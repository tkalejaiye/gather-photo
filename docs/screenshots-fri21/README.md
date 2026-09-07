# FRI-21 — offline shell, verification evidence

Produced by `npm run verify:fri21 -- --slug <event-slug>` against a production
build (`npm run build && npm start`) and a real headless Chrome driven over the
DevTools Protocol. Event used: `Test event 2` (open, no PIN).

| Screenshot | What it shows |
|---|---|
| `01-online-first-visit.png` | First visit, online. Worker registers and warms the shell + 18 asset entries. |
| `02-offline-reload.png` | **The criterion.** Network offline, HTTP cache cleared *and* disabled, page reloaded — the guest page still renders, fully styled. Cache Storage was the only possible source. |
| `03-offline-picker.png` | Still offline: the picker is interactive, so the page hydrated from cached chunks. |
| `04-offline-queued-progress-screen.png` | Two photos compressed and queued **while offline** — "SHOT 1 20.8 KB 0% / SHOT 2 QUEUED". |
| `05-reconnected-drained.png` | Network restored → the queue drained → "You're in the roll! 2 shots added." |
| `06-kill-switch-applied.png` | `cp docs/sw-kill-switch.js public/sw.js` → worker unregistered, every `gather-*` cache deleted, page back on the live network path. |
| `network-trace.json` | Every response of the session with Chrome's `fromServiceWorker` flag. |

## The offline reload really came from Cache Storage

Phase 2 calls `Network.clearBrowserCache` + `Network.setCacheDisabled` before
reloading. Without that, Chrome's heuristic caching of the document makes the
test pass with an empty shell cache — it did exactly that during development,
which is why the check is written this way.

Phase 1 asserts `gather-shell-v1` contains the guest URL *before* going offline;
phase 2 asserts the navigation response has `fromServiceWorker: true`.

## How the upload bypass was confirmed

Chrome reports `Network.responseReceived.response.fromServiceWorker` for every
response. The script asserts it is `false` for **all** Supabase TUS traffic and
all `/api/uploads/*` calls, and that the only responses the worker ever served
across the whole session are guest HTML, `/_next/static/*`, and the precached
manifest/icons. A representative drained upload:

```
net  201 https://…supabase.co/storage/v1/upload/resumable          (TUS create)
net  200 https://…supabase.co/storage/v1/upload/resumable/…        (HEAD resume)
net  204 https://…supabase.co/storage/v1/upload/resumable/…        (PATCH bytes)
net  200 http://localhost:3000/api/uploads/register
```

`net` = handled natively by the browser; the worker returned without calling
`event.respondWith`. See `public/sw.js` → `shouldBypass`.

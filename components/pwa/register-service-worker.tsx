type Props = {
  /** `events.uploads_close_at` — stamped on the cached shell so an offline
   *  guest is never handed a working picker for an event that has ended. */
  closeAt?: string | null;
};

// Registers public/sw.js — the guest-route offline shell (FRI-21).
//
// This is a server component that emits an inline <script>, not a client
// component, and that is deliberate: `/e/[slug]` has a 110 kB First Load JS
// budget (TECH_SPEC §8) and a client component for this glue would spend
// bundle bytes on it. Inline HTML costs zero JS chunk.
//
// It does two things, and the second one is the whole feature:
//
//  1. registers the worker on `load`, so it never competes with the
//     compress/upload path for a congested connection on first paint;
//  2. posts `gather-warm-shell` naming this page and the /_next/static/
//     assets it has loaded — and keeps posting as more arrive.
//
// (2) exists because a page that loads with no controller stays uncontrolled
// for that navigation — the worker cannot cache an HTML document it never
// saw. Without this handshake the shell cache would still be empty on the
// visit that matters (guest scans QR → queues photos → network dies →
// reloads → offline error page, queue never drains).
//
// The PerformanceObserver (rather than a one-shot snapshot at `load`) is what
// catches the chunks that arrive later: the compressor, the queue and the
// uploader are all dynamically imported after mount or on first pick, and a
// snapshot taken at `load` misses every one of them — which would leave the
// guest with a shell that opens offline but cannot actually take a photo.
// `buffered: true` replays the entries already recorded, so one observer
// covers both halves. Posts are debounced and `warm()` only fetches gaps.
//
// Rendering this component is also the SIGNAL that a page is safe to serve
// offline — it is mounted only on the unlocked, still-open branch of
// app/e/[slug]/page.tsx, so the PIN prompt and the "event has ended" page
// never become the offline shell.
//
// To disable the worker in production, see the kill switch in RUNBOOK.md §8 —
// removing this component is NOT enough on its own, because already-installed
// workers stay registered on guests' phones.
export function RegisterServiceWorker({ closeAt }: Props) {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: [
          "if('serviceWorker' in navigator){addEventListener('load',function(){",
          "navigator.serviceWorker.register('/sw.js').then(function(reg){",
          "return navigator.serviceWorker.ready.then(function(){",
          "var w=reg.active||navigator.serviceWorker.controller;if(!w)return;",
          `var C=${JSON.stringify(closeAt ?? null)};`,
          "var p=location.origin+'/_next/static/',seen={},pending=[],t=null;",
          "function post(){t=null;var a=pending;pending=[];",
          "w.postMessage({type:'gather-warm-shell',url:location.href,assets:a,closeAt:C})}",
          "function later(){if(!t)t=setTimeout(post,1200)}",
          "function add(ns){for(var i=0;i<ns.length;i++){var n=ns[i];",
          "if(n.indexOf(p)===0&&!seen[n]){seen[n]=1;pending.push(n)}}later()}",
          "try{new PerformanceObserver(function(l){",
          "add(l.getEntries().map(function(e){return e.name}))",
          "}).observe({type:'resource',buffered:true})}catch(e){",
          "add(performance.getEntriesByType('resource').map(function(e){return e.name}))}",
          "later()",
          "})}).catch(function(){})})}",
        ].join(""),
      }}
    />
  );
}

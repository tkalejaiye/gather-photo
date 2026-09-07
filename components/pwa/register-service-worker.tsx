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
//  2. once the worker is active, posts `gather-warm-shell` naming this page
//     and the /_next/static/ assets it actually loaded.
//
// (2) exists because a page that loads with no controller stays uncontrolled
// for that navigation — the worker cannot cache an HTML document it never
// saw. Without this handshake the shell cache would still be empty on the
// visit that matters (guest scans QR → queues photos → network dies →
// reloads → offline error page, queue never drains). `warm()` in sw.js only
// fetches what is missing, so this costs one HTML request on the first visit
// and nothing afterwards.
//
// Rendering this component is also the SIGNAL that a page is safe to serve
// offline — it is mounted only on the unlocked, still-open branch of
// app/e/[slug]/page.tsx, so the PIN prompt and the "event has ended" page
// never become the offline shell.
//
// To disable the worker in production, see the kill switch in RUNBOOK.md §8 —
// removing this component is NOT enough on its own, because already-installed
// workers stay registered on guests' phones.
export function RegisterServiceWorker() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: [
          "if('serviceWorker' in navigator){addEventListener('load',function(){",
          "navigator.serviceWorker.register('/sw.js').then(function(reg){",
          "return navigator.serviceWorker.ready.then(function(){",
          "var w=reg.active||navigator.serviceWorker.controller;if(!w)return;",
          "var p=location.origin+'/_next/static/';",
          "var a=performance.getEntriesByType('resource').map(function(e){return e.name})",
          ".filter(function(n){return n.indexOf(p)===0});",
          "w.postMessage({type:'gather-warm-shell',url:location.href,assets:a})",
          "})}).catch(function(){})})}",
        ].join(""),
      }}
    />
  );
}

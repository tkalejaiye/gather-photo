// FRI-21 — prove the offline shell in a real browser.
//
// The acceptance criterion that matters is not "a service worker exists", it
// is: a guest on a dead venue network can still OPEN the page, and the photos
// already sitting in their IndexedDB queue drain when the network returns.
// This script drives a real headless Chrome over the DevTools Protocol and
// checks exactly that, plus the two properties that protect the upload path:
//
//   1. first visit online   → worker registers and warms the shell + assets
//   2. OFFLINE reload       → page renders, with the HTTP cache cleared AND
//                             disabled, so Cache Storage is the only source
//   3. queue photos offline → rows persist in the IndexedDB queue
//   4. reconnect            → the queue drains and media rows register
//   5. bypass               → no upload response has fromServiceWorker=true
//   6. kill switch          → docs/sw-kill-switch.js unregisters + clears
//
// Usage (needs a build + a running server and an OPEN event):
//   npm run build && npm start
//   npm run verify:fri21 -- --slug <event-slug>
//
// Options: --base (default http://localhost:3000), --out (default
// docs/screenshots-fri21). It uploads two generated test photos to the event
// you name, so point it at a test event. macOS Chrome path is assumed.
//
// No browser-automation dependency on purpose: this repo ships nothing for
// driving Chrome, and the guest bundle budget (TECH_SPEC §8) is not the place
// to start. Node 22 has a global WebSocket, which is all CDP needs.

import { spawn } from "node:child_process";


const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function launchChrome(profileDir, port = 9222) {
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--window-size=430,932",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { child, port };
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome did not expose a debugging port");
}

async function newTab(port, url = "about:blank") {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  return res.json();
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.events = [];
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        for (const h of this.handlers) h(msg);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new Session(ws);
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30000);
    });
  }

  on(fn) {
    this.handlers.push(fn);
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async evalJson(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression: `(async()=>{ return (${expression}) })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
    return result.value;
  }

  waitForEvent(method, predicate = () => true, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const existing = this.events.find((e) => e.method === method && predicate(e.params));
      if (existing) return resolve(existing.params);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeout);
      this.on((msg) => {
        if (msg.method === method && predicate(msg.params)) {
          clearTimeout(timer);
          resolve(msg.params);
        }
      });
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/** Two throwaway "photos". Hand-rolled PNG encoder — see
 *  scripts/generate-icons.mjs; this repo carries no image dependency. */
function writeTestPhotos(dir) {
  const T = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = -1;
    for (let i = 0; i < b.length; i += 1) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const png = (w, h, fn) => {
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y += 1) {
      raw[y * (w * 4 + 1)] = 0;
      for (let x = 0; x < w; x += 1) {
        const [r, g, b] = fn(x, y);
        const i = y * (w * 4 + 1) + 1 + x * 4;
        raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
    ]);
  };
  writeFileSync(`${dir}/offline-shot-1.png`, png(1200, 900, (x, y) => [(x * 255 / 1200) | 0, (y * 255 / 900) | 0, 140]));
  writeFileSync(`${dir}/offline-shot-2.png`, png(1200, 900, (x, y) => [200, ((x + y) * 255 / 2100) | 0, (y * 255 / 900) | 0]));
}

import { writeFileSync, mkdirSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]);
}
const SLUG = args.get("slug");
if (!SLUG) {
  console.error("--slug <event-slug> is required (use an OPEN test event — this uploads to it).");
  process.exit(1);
}
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = args.get("base") ?? "http://localhost:3000";
const URL_ = `${BASE}/e/${SLUG}`;
const OUT = args.get("out") ?? path.join(REPO, "docs/screenshots-fri21");
const WORK = mkdtempSync(path.join(tmpdir(), "fri21-"));
const SHOTS = WORK;
const PROFILE = path.join(WORK, "chrome-profile");
mkdirSync(OUT, { recursive: true });
writeTestPhotos(SHOTS);

const log = (...a) => console.log(...a);
const ok = (cond, msg) => log(`${cond ? "  PASS" : "  FAIL"}  ${msg}`);
let failures = 0;
const assert = (cond, msg) => { ok(cond, msg); if (!cond) failures += 1; };

const { child, port } = await launchChrome(PROFILE);
const tab = await newTab(port, "about:blank");
const s = await Session.connect(tab.webSocketDebuggerUrl);

await s.send("Page.enable");
await s.send("Network.enable");
await s.send("Runtime.enable");
await s.send("DOM.enable");

// Every response, with the flag that answers "did the worker serve this?"
const responses = [];
const allResponses = [];
s.on((m) => {
  if (m.method === "Network.responseReceived") {
    allResponses.push({
      url: m.params.response.url,
      fromServiceWorker: m.params.response.fromServiceWorker === true,
    });
    responses.push({
      url: m.params.response.url,
      status: m.params.response.status,
      fromServiceWorker: m.params.response.fromServiceWorker === true,
      type: m.params.type,
    });
  }
  if (m.method === "Network.requestWillBeSent") {
    responses.push({ req: true, url: m.params.request.url, method: m.params.request.method });
  }
});

const shot = async (name) => {
  const { data } = await s.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
  log(`  · screenshot → ${name}.png`);
};

const swState = () =>
  s.evalJson(`(async()=>{
    const regs = await navigator.serviceWorker.getRegistrations();
    const names = await caches.keys();
    const out = { registrations: regs.map(r=>({scope:r.scope, active:!!r.active, state:r.active&&r.active.state})), caches:{} };
    for (const n of names) { const c = await caches.open(n); out.caches[n] = (await c.keys()).map(r=>r.url); }
    out.controlled = !!navigator.serviceWorker.controller;
    return out;
  })()`);

const queueRows = () =>
  s.evalJson(`(async()=>{
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d=>/gather/i.test(d.name||''))||{}).name;
    if (!name) return { db:null, rows:[] };
    const db = await new Promise((res,rej)=>{ const r=indexedDB.open(name); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
    const store = db.objectStoreNames[0];
    const rows = await new Promise((res,rej)=>{ const t=db.transaction(store,'readonly').objectStore(store).getAll(); t.onsuccess=()=>res(t.result); t.onerror=()=>rej(t.error); });
    return { db:name, rows: rows.map(r=>({id:r.id, status:r.status, progress:r.progress, bytes:r.data?(r.data.byteLength||r.data.size):null, error:r.error||null, tus:!!r.tusUploadUrl})) };
  })()`);

// ─── 1. first visit, online ────────────────────────────────────────────────
log("\n[1] FIRST VISIT (online)");
await s.send("Page.navigate", { url: URL_ });
await s.waitForEvent("Page.loadEventFired");
// `warm()` re-fetches the guest HTML, which re-runs the server-side Supabase
// count, so the handshake completes a second or two after `load`. Poll.
let state = null;
const t0 = Date.now();
for (let i = 0; i < 30; i += 1) {
  await sleep(1000);
  state = await swState();
  const shell = state.caches["gather-shell-v1"] || [];
  const assets = state.caches["gather-assets-v1"] || [];
  if (shell.length > 0 && assets.some((u) => u.includes("/_next/static/"))) break;
}
log(`  shell warmed after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
log("  " + JSON.stringify(state.registrations));
assert(state.registrations.some((r) => r.active && r.state === "activated"), "service worker activated");
const shellCache = state.caches["gather-shell-v1"] || [];
const assetCache = state.caches["gather-assets-v1"] || [];
log(`  shell cache: ${JSON.stringify(shellCache)}`);
log(`  asset cache: ${assetCache.length} entries, e.g. ${assetCache.slice(0, 3).join(", ")}`);
assert(shellCache.includes(URL_), "guest shell warmed into gather-shell-v1 on the FIRST visit");
assert(assetCache.some((u) => u.includes("/_next/static/")), "first-load chunks warmed into gather-assets-v1");
assert(assetCache.some((u) => u.endsWith("/manifest.webmanifest")), "manifest precached");
assert(assetCache.some((u) => u.endsWith("/icon-192.png")), "icon-192 precached (no more 404)");
await shot("01-online-first-visit");

// ─── 2. offline reload ─────────────────────────────────────────────────────
log("\n[2] OFFLINE RELOAD (the criterion that matters)");
await s.send("Network.emulateNetworkConditions", {
  offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
});
// Disable the HTTP cache and wipe it, so a successful offline render can ONLY
// have come from Cache Storage — otherwise Chrome's heuristic caching of the
// document would make this test pass without any shell cache at all.
await s.send("Network.clearBrowserCache");
await s.send("Network.setCacheDisabled", { cacheDisabled: true });
log("  network: OFFLINE, HTTP cache cleared + disabled (Cache Storage is the only possible source)");
responses.length = 0;
await s.send("Page.reload", { ignoreCache: false });
await s.waitForEvent("Page.loadEventFired");
await sleep(2500);
const title = await s.evalJson(`document.title`);
const bodyText = await s.evalJson(`document.body.innerText.slice(0,200)`);
const eventName = await s.evalJson(`(document.querySelector('h1')||{}).innerText||''`);
log(`  title: ${JSON.stringify(title)}`);
log(`  h1:    ${JSON.stringify(eventName)}`);
assert(!/no internet|ERR_INTERNET/i.test(bodyText), "no browser offline error page");
assert(eventName.length > 0, "guest shell rendered offline with the event heading");
const navResp = responses.find((r) => !r.req && r.url === URL_ && r.type === "Document");
log(`  navigation response: ${JSON.stringify(navResp)}`);
assert(navResp && navResp.fromServiceWorker === true, "the navigation WAS served by the service worker");
const hydrated = await s.evalJson(`typeof indexedDB !== 'undefined' && !!document.querySelector('button')`);
assert(hydrated, "page has interactive UI while offline");
await shot("02-offline-reload");

// ─── 3. queue photos while offline ─────────────────────────────────────────
log("\n[3] QUEUE PHOTOS WHILE OFFLINE");
// landing → picker (the flow asks for a name first when none is stored)
await s.evalJson(`(async()=>{
  const click = (re) => { const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText)); if(b) b.click(); return !!b; };
  click(/add|start|photo|upload|shots/i);
  await new Promise(r=>setTimeout(r,600));
  const input = document.querySelector('input[type=text],input:not([type=file])');
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(input, 'Offline Guest');
    input.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,300));
    click(/continue/i);
  }
  await new Promise(r=>setTimeout(r,800));
  return document.body.innerText.slice(0,120);
})()`);
await shot("03-offline-picker");
const { result: inputObj } = await s.send("Runtime.evaluate", {
  expression: `[...document.querySelectorAll('input[type=file]')].pop()`,
});
await s.send("DOM.setFileInputFiles", {
  files: [`${SHOTS}/offline-shot-1.png`, `${SHOTS}/offline-shot-2.png`],
  objectId: inputObj.objectId,
});
await sleep(4000);
// Commit the batch so the guest sees the progress screen (still offline).
await s.evalJson(`(async()=>{
  const b=[...document.querySelectorAll('button')].find(x=>/add \\d+ shot/i.test(x.innerText));
  if(b) b.click();
  await new Promise(r=>setTimeout(r,1200));
  return document.body.innerText.slice(0,160);
})()`);
await sleep(1500);
let q = await queueRows();
log(`  IndexedDB "${q.db}": ${JSON.stringify(q.rows)}`);
assert(q.rows.length >= 2, "2 photos compressed and persisted to the IndexedDB queue while offline");
assert(q.rows.every((r) => r.bytes > 0), "queued rows hold real compressed bytes");
assert(q.rows.every((r) => r.status !== "done"), "nothing uploaded while offline (as expected)");
await shot("04-offline-queued-progress-screen");

// ─── 4. reconnect and drain ────────────────────────────────────────────────
log("\n[4] RECONNECT → DRAIN");
responses.length = 0;
await s.send("Network.emulateNetworkConditions", {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});
await s.evalJson(`(dispatchEvent(new Event('online')), true)`);
log("  network: ONLINE, dispatched `online`");
let drained = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(1500);
  q = await queueRows();
  const done = q.rows.filter((r) => r.status === "done").length;
  const failed = q.rows.filter((r) => r.status === "failed");
  if (i % 3 === 0) log(`  t+${((i + 1) * 1.5).toFixed(1)}s ${JSON.stringify(q.rows.map(r=>[r.status, r.progress]))}`);
  if (failed.length) { log(`  failed rows: ${JSON.stringify(failed)}`); }
  if (done >= 2 || (q.rows.length && q.rows.every((r) => r.status === "done"))) { drained = q; break; }
}
q = await queueRows();
log(`  final queue: ${JSON.stringify(q.rows)}`);
assert(!!drained, "queued photos drained after reconnect");
await sleep(2500);
log(`  final screen: ${JSON.stringify(await s.evalJson(`document.body.innerText.replace(/\\s+/g,' ').slice(0,140)`))}`);
await shot("05-reconnected-drained");

// ─── 5. the bypass ─────────────────────────────────────────────────────────
log("\n[5] BYPASS — upload traffic must never be served by the worker");
const uploadReqs = responses.filter(
  (r) => !r.req && (/supabase\.co/.test(r.url) || /\/api\/uploads\//.test(r.url)),
);
for (const r of uploadReqs) log(`  ${r.fromServiceWorker ? "SW!!" : "net "} ${r.status} ${r.url.slice(0, 110)}`);
assert(uploadReqs.length > 0, "upload traffic actually happened (something to check)");
assert(uploadReqs.every((r) => r.fromServiceWorker === false), "NO upload response has fromServiceWorker=true");
const swServed = allResponses.filter((r) => r.fromServiceWorker);
log(`  responses served by the worker across the whole session: ${swServed.length}`);
for (const r of swServed.slice(0, 12)) log(`    SW ${r.url.slice(0, 100)}`);
assert(
  swServed.every(
    (r) =>
      r.url.startsWith(`${BASE}/e/`) ||
      r.url.includes("/_next/static/") ||
      /\/(manifest\.webmanifest|icon-(192|512)\.png)$/.test(r.url),
  ),
  "the worker only ever served guest HTML, hashed static assets, and the precached manifest/icons",
);

// ─── 6. kill switch ────────────────────────────────────────────────────────
log("\n[6] KILL SWITCH (RUNBOOK §8)");
copyFileSync(`${REPO}/public/sw.js`, `${WORK}/sw.js.backup`);
copyFileSync(`${REPO}/docs/sw-kill-switch.js`, `${REPO}/public/sw.js`);
log("  cp docs/sw-kill-switch.js public/sw.js");
try {
  await s.send("Page.reload", { ignoreCache: false });
  await s.waitForEvent("Page.loadEventFired");
  await sleep(4000);
  let after = await swState();
  for (let i = 0; i < 10 && after.registrations.length > 0; i += 1) {
    await sleep(1000);
    after = await swState();
  }
  log(`  registrations: ${JSON.stringify(after.registrations)}`);
  log(`  caches: ${JSON.stringify(Object.keys(after.caches))}`);
  assert(after.registrations.length === 0, "worker unregistered itself on already-installed clients");
  assert(
    Object.keys(after.caches).every((n) => !n.startsWith("gather-")),
    "every gather-* cache deleted",
  );
  allResponses.length = 0;
  await s.send("Page.navigate", { url: URL_ });
  await s.waitForEvent("Page.loadEventFired");
  await sleep(1500);
  assert(
    allResponses.filter((r) => r.fromServiceWorker).length === 0,
    "nothing is served by a worker any more — plain website again",
  );
  await shot("06-kill-switch-applied");
} finally {
  copyFileSync(`${WORK}/sw.js.backup`, `${REPO}/public/sw.js`);
  log("  restored public/sw.js");
}

writeFileSync(`${OUT}/network-trace.json`, JSON.stringify(responses.filter((r) => !r.req), null, 1));
log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
await s.send("Browser.close").catch(() => {});
child.kill();
process.exit(failures === 0 ? 0 : 1);

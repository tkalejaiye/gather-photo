import archiver from "archiver";
import { Readable } from "node:stream";
import { createClient } from "@/lib/supabase/server";
import { ownsEvent } from "@/lib/gallery/queries";
import {
  DOWNLOAD_BATCH_SIZE,
  iterateDownloadableMedia,
  signPathsForDownload,
  zipDownloadFilename,
  zipEntryName,
} from "@/lib/gallery/download";

// GET /api/events/[id]/download?include=pending
// FRI-18 / TECH_SPEC §6 §10 · Host-only, streamed ZIP of the event's media
// in the originally-uploaded quality. Delivered as `Content-Disposition:
// attachment` so a plain `<a href>` triggers a browser download.
// FRI-30: exports approved media by default; `?include=pending` adds the
// not-yet-approved queue (host-only route, so no exposure widening).
//
// Streaming shape:
//   1. Walk active media in pages of DOWNLOAD_BATCH_SIZE — never load the
//      full row set for a large event.
//   2. Sign each page's storage paths in a single service-role batch call.
//   3. For each item: fetch the signed URL, hand the response body to
//      archiver as a Node stream, and AWAIT the "entry" event before
//      starting the next fetch. That serialization is what keeps peak
//      memory flat regardless of gallery size: one HTTP connection open,
//      one archiver entry in flight.
//   4. Convert archiver's Node Readable → Web ReadableStream via
//      Readable.toWeb so Next's Response can stream it out.
//
// Chunked/multiple ZIPs (TECH_SPEC §10 "large ZIPs → stream / chunk"): not
// implemented in MVP. The streaming shape above holds memory flat, which
// covers the "1,000-photo owambe" scale we're validating against. If a
// future event exceeds the platform's request timeout we can split by
// uploader or by created-at week — this file's helpers already sort/
// partition on both fields.
export const runtime = "nodejs";
// Cache poisoning here would hand one host's photos to another. `force-dynamic`
// beats any accidental fetch cache below us.
export const dynamic = "force-dynamic";

// STORE mode (compression level 0). Photos are already JPEG/HEIF/PNG which
// compress to within a percent or two of their original size; running deflate
// on them burns CPU and wall time for near-zero payoff. STORE also keeps the
// ZIP producer CPU-bound-per-byte constant, which matters when we're the
// bottleneck between object storage and the host's browser.
const ARCHIVER_OPTS = {
  zlib: { level: 0 as const },
  store: true,
} as const;

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // Ownership gate. RLS on `events` returns null for a foreign id, giving
  // an indistinguishable 404 — matches the delete route's shape.
  const owned = await ownsEvent(supabase, params.id);
  if (!owned) {
    return new Response(JSON.stringify({ error: "Event not found." }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  // Pull the slug for the download filename. `.slug` is scoped to the host
  // by RLS; the ownsEvent call above already established the row exists.
  const { data: eventRow } = await supabase
    .from("events")
    .select("slug")
    .eq("id", params.id)
    .maybeSingle();
  const slug = eventRow?.slug ?? params.id;
  const filename = zipDownloadFilename(slug, new Date());

  // FRI-30: `?include=pending` opts the un-reviewed queue into the export.
  // Anything other than the exact value falls back to the safe default
  // (approved only) — a typo shouldn't widen the export.
  const includePending =
    new URL(req.url).searchParams.get("include") === "pending";

  const archive = archiver("zip", ARCHIVER_OPTS);

  // Producer: walk media, sign each page, drain items serially into the
  // archive. Runs on a floating promise; its lifecycle is bound to the
  // archive's finalize / error events so errors surface on the response
  // stream. We deliberately do NOT await the producer here — awaiting
  // would buffer the entire ZIP before Next started sending headers.
  const produce = async () => {
    // Track filenames across pages so a rare collision (same short-id
    // prefix + same uploader + same date) still produces a unique entry.
    const seenNames = new Set<string>();
    try {
      for await (const page of iterateDownloadableMedia(
        supabase,
        params.id,
        DOWNLOAD_BATCH_SIZE,
        { includePending },
      )) {
        const paths = page.map((r) => r.storage_path);
        const urls = await signPathsForDownload(paths);
        for (const row of page) {
          const signed = urls.get(row.storage_path);
          if (!signed) {
            // Object gone under the row (deleted from storage but the row
            // still says 'active'). Skip and press on — a lone bad file
            // shouldn't tank the whole download. `signPathsForDownload`
            // already logs batch-level signer failures; a per-row null
            // after a successful batch means this specific object is gone.
            console.warn(`[download] no signed URL for ${row.storage_path}`);
            continue;
          }
          const res = await fetch(signed);
          if (!res.ok || !res.body) {
            // TECH_SPEC §8 asks for "no silent upload failures" on the guest
            // side; mirror that spirit here so a systematically failing
            // object bucket surfaces in the ops log rather than producing
            // a mysteriously short ZIP that the host will notice first.
            console.warn(
              `[download] fetch failed for ${row.storage_path}: HTTP ${res.status}`,
            );
            continue;
          }
          const name = zipEntryName(row, seenNames);
          const nodeStream = Readable.fromWeb(
            res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
          );
          // Register the entry/error listeners BEFORE calling append. In
          // practice archiver processes appends via its async queue so
          // ordering the other way still works, but registering first is
          // race-free even if a future archiver revision drains a small
          // in-memory stream synchronously. The rejection path lets a
          // stream failure abort the download rather than hang.
          const entryDrained = new Promise<void>((resolve, reject) => {
            const onEntry = () => {
              archive.off("error", onError);
              resolve();
            };
            const onError = (err: Error) => {
              archive.off("entry", onEntry);
              reject(err);
            };
            archive.once("entry", onEntry);
            archive.once("error", onError);
          });
          archive.append(nodeStream, { name });
          // Await archiver consuming this entry before we open the next
          // signed URL. Without this, N pages of 200 items each would open
          // N × 200 concurrent HTTP connections and defeat the whole
          // "constant memory" property.
          await entryDrained;
        }
      }
      await archive.finalize();
    } catch (err) {
      // Abort the ZIP so the consumer sees a truncated response instead of
      // a hang. archiver.abort() ends the underlying Readable with an
      // 'error' — which Next surfaces as a broken stream to the browser.
      // Better than pretending the ZIP is complete.
      try {
        archive.abort();
      } catch {
        // ignore — nothing else we can do here
      }
      // Re-throwing would surface as an unhandled rejection since produce()
      // is a floating promise. Swallow after abort — the response error path
      // is enough for the host to notice.
      console.error("[download] producer failed", err);
    }
  };

  // Start the producer before wrapping the readable so the pipe is already
  // being fed by the time Next attaches to it.
  void produce();

  const webBody = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>;

  return new Response(webBody, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      // Quoted filename tolerates the hyphen and date; ASCII-only so no
      // RFC 5987 encoding needed.
      "content-disposition": `attachment; filename="${filename}"`,
      // Streaming: no length known upfront; explicitly disable buffering
      // hints so intermediate proxies (Vercel edge, Cloudflare) forward
      // bytes as they arrive.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

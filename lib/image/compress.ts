import imageCompression from "browser-image-compression";

export interface CompressResult {
  /** Re-encoded, downscaled JPEG ready to enqueue/upload. */
  blob: Blob;
  /** Pixel width of the output (orientation already baked in). */
  width: number;
  /** Pixel height of the output (orientation already baked in). */
  height: number;
  /** SHA-256 (hex) of the ORIGINAL source bytes — stable identity for per-event dedupe. */
  contentHash: string;
}

const MAX_EDGE = 2048; // long-edge target — TECH_SPEC §5
const QUALITY = 0.8; // re-encode quality — TECH_SPEC §5

// iOS hands us these for HEIC/HEIF captures; the type is sometimes empty, so we
// also fall back to the filename extension.
const HEIC_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

type CompressOptions = Parameters<typeof imageCompression>[1];

/**
 * Browser-only primitives, factored out so the orchestration in {@link compress}
 * can be unit-tested in a node environment (which can't decode image pixels).
 * Production always uses {@link defaultDeps}; tests override only the seams they
 * need and keep the real `sha256`.
 */
export interface CompressDeps {
  /** Decode a HEIC/HEIF file and re-encode it as a JPEG blob. */
  heicToJpeg: (file: File) => Promise<Blob>;
  /** Downscale + re-encode (bakes EXIF orientation, strips metadata). */
  compressImage: (file: File, opts: CompressOptions) => Promise<Blob>;
  /** Read the pixel dimensions of an encoded image blob. */
  readDimensions: (blob: Blob) => Promise<{ width: number; height: number }>;
  /** SHA-256 (hex) of a blob's bytes. */
  sha256: (blob: Blob) => Promise<string>;
}

/**
 * Compress an image for fast, reliable upload on a congested venue network.
 * - converts HEIC/HEIF → JPEG (iPhone guests) before anything else
 * - downscales to ~2048px on the long edge, re-encodes at ~0.8 quality
 * - bakes EXIF orientation into the pixels and strips metadata (no sideways images)
 * - returns a SHA-256 of the *source* bytes for per-event dedupe (TECH_SPEC §10)
 *
 * @param overrides test-only seams; production omits this and uses real browser APIs.
 */
export async function compress(
  file: File,
  overrides: Partial<CompressDeps> = {},
): Promise<CompressResult> {
  const { heicToJpeg, compressImage, readDimensions, sha256 } = {
    ...defaultDeps,
    ...overrides,
  };

  // Hash the original bytes: re-encoding isn't byte-deterministic across devices
  // or encoder versions, so hashing the source gives a stable dedupe identity.
  const contentHash = await sha256(file);

  // HEIC can't be decoded by the canvas pipeline — convert to JPEG first.
  const source = isHeic(file) ? toJpegFile(await heicToJpeg(file), file.name) : file;

  const compressed = await compressImage(source, {
    maxWidthOrHeight: MAX_EDGE,
    initialQuality: QUALITY,
    fileType: "image/jpeg", // normalize all outputs to JPEG
    useWebWorker: true,
    preserveExif: false, // orientation is baked into pixels; drop metadata to save bytes
  });

  // iOS Safari's IndexedDB throws "Error preparing Blob/File data to be stored
  // in object store" on some worker-produced Blobs/Files — the structured
  // clone path treats them as lifecycle-fragile and refuses to persist. Copy
  // the bytes into a fresh main-thread Blob before returning so the enqueue in
  // `lib/upload/queue.ts` can persist it durably on all iOS versions.
  const blob = new Blob([await compressed.arrayBuffer()], {
    type: compressed.type || "image/jpeg",
  });

  const { width, height } = await readDimensions(blob);
  return { blob, width, height, contentHash };
}

/** True for HEIC/HEIF input, by MIME type or `.heic`/`.heif` extension fallback. */
export function isHeic(file: File): boolean {
  if (HEIC_TYPES.has((file.type || "").toLowerCase())) return true;
  return /\.(heic|heif)$/i.test(file.name || "");
}

async function defaultHeicToJpeg(file: File): Promise<Blob> {
  // Lazy import: libheif's wasm is heavy (~MBs). Loading it only when an iPhone
  // guest actually supplies a HEIC keeps the base guest bundle tiny (CLAUDE.md).
  const { default: heic2any } = await import("heic2any");
  const out = await heic2any({ blob: file, toType: "image/jpeg", quality: QUALITY });
  // For a HEIC *sequence* (e.g. Live Photo) heic2any returns a frame array;
  // photos-first means we keep the still primary frame (TECH_SPEC §1).
  return Array.isArray(out) ? out[0] : out;
}

async function defaultReadDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const dims = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dims;
}

async function defaultSha256(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const defaultDeps: CompressDeps = {
  heicToJpeg: defaultHeicToJpeg,
  compressImage: (file, opts) => imageCompression(file, opts),
  readDimensions: defaultReadDimensions,
  sha256: defaultSha256,
};

/** Wrap a (possibly HEIC-converted) blob as a `.jpg` File for the compressor. */
function toJpegFile(blob: Blob, originalName: string): File {
  const name = originalName.replace(/\.(heic|heif)$/i, ".jpg");
  return new File([blob], name, { type: "image/jpeg" });
}

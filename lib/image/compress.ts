import imageCompression from "browser-image-compression";

export interface CompressResult {
  blob: Blob;
  width: number;
  height: number;
  contentHash: string;
}

const DEFAULTS = {
  maxWidthOrHeight: 2048,
  initialQuality: 0.8,
  useWebWorker: true,
  // browser-image-compression also corrects EXIF orientation.
};

/**
 * Compress an image for fast upload on slow networks.
 * - downscales to ~2048px long edge
 * - re-encodes at ~0.8 quality
 * - converts HEIC/HEIF to JPEG
 * - corrects EXIF orientation
 * - returns a content hash for per-event dedupe
 *
 * TODO(M1): implement HEIC detection/conversion + sha-256 hashing + dimension read.
 */
export async function compress(file: File): Promise<CompressResult> {
  const blob = await imageCompression(file, DEFAULTS);
  const contentHash = await sha256(blob);
  const { width, height } = await readDimensions(blob);
  return { blob, width, height, contentHash };
}

async function sha256(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const dims = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dims;
}

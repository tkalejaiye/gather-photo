import { describe, it, expect, vi } from "vitest";
import { compress, isHeic, type CompressDeps } from "@/lib/image/compress";

type CompressImageArgs = Parameters<CompressDeps["compressImage"]>;

// The test environment is `node` (see vitest.config.ts), which cannot decode
// image pixels. So we keep the parts that ARE real in node — SHA-256 hashing
// (node webcrypto) and HEIC detection — and stub only the browser-only seams
// (heic2any/libheif, canvas re-encode, createImageBitmap).
//
// AC coverage map (issue FRI-10):
//   - contentHash stable + correct dims ......... unit-tested for real below
//   - HEIC routed to a JPEG conversion .......... wiring unit-tested below
//   - "materially smaller" (real ratio) ......... delegated to browser-image-compression,
//                                                 validated by the on-device gate (TECH_SPEC §5)
//   - EXIF orientation baked (real pixels) ...... delegated to the canvas re-encode / libheif,
//                                                 validated by the on-device gate (TECH_SPEC §5)
// Tests below that touch the stubbed compressor assert WIRING (we call it, pass
// the right options, return its output) — not the real compression result.

function jpeg(bytes: number, name = "photo.jpg"): File {
  // Deterministic, repeatable bytes so the hash is stable across runs.
  return new File([new Uint8Array(bytes).fill(7)], name, { type: "image/jpeg" });
}

function heic(bytes = 4000, name = "IMG_0001.HEIC", type = "image/heic"): File {
  return new File([new Uint8Array(bytes).fill(9)], name, { type });
}

/** Real sha256 (node webcrypto), browser seams stubbed for a downscale to 1600x1200. */
function fakeDeps(over: Partial<CompressDeps> = {}): Partial<CompressDeps> {
  return {
    heicToJpeg: vi.fn(async () => new Blob([new Uint8Array(1500).fill(1)], { type: "image/jpeg" })),
    // Simulate the real compressor: emit a materially smaller JPEG blob.
    compressImage: vi.fn(async () => new Blob([new Uint8Array(1200).fill(2)], { type: "image/jpeg" })),
    readDimensions: vi.fn(async () => ({ width: 1600, height: 1200 })),
    ...over,
  };
}

describe("isHeic", () => {
  it("detects HEIC/HEIF by MIME type", () => {
    for (const type of ["image/heic", "image/heif", "image/HEIC", "image/heic-sequence"]) {
      expect(isHeic(new File([], "x", { type }))).toBe(true);
    }
  });

  it("falls back to extension when iOS gives an empty type", () => {
    expect(isHeic(new File([], "IMG_1234.HEIC", { type: "" }))).toBe(true);
    expect(isHeic(new File([], "pic.heif", { type: "" }))).toBe(true);
  });

  it("returns false for ordinary JPEG/PNG", () => {
    expect(isHeic(new File([], "p.jpg", { type: "image/jpeg" }))).toBe(false);
    expect(isHeic(new File([], "p.png", { type: "image/png" }))).toBe(false);
  });
});

describe("compress", () => {
  it("returns the compressor's JPEG output as the result blob (wiring)", async () => {
    // NOTE: real size reduction is the compressor's job (on-device gate, §5).
    // This only asserts we pass the input through and surface the output blob.
    const input = jpeg(50_000);
    const { blob } = await compress(input, fakeDeps());
    expect(blob.size).toBeLessThan(input.size); // stub returns a smaller blob
    expect(blob.type).toBe("image/jpeg");
  });

  it("returns the dimensions read from the compressed output", async () => {
    const { width, height } = await compress(jpeg(20_000), fakeDeps());
    expect(width).toBe(1600);
    expect(height).toBe(1200);
  });

  it("re-encodes to JPEG at the spec's target edge/quality", async () => {
    const compressImage = vi.fn(
      async (..._args: CompressImageArgs) => new Blob([new Uint8Array(10).fill(2)], { type: "image/jpeg" }),
    );
    await compress(jpeg(20_000), fakeDeps({ compressImage }));
    const opts = compressImage.mock.calls[0][1];
    expect(opts.maxWidthOrHeight).toBe(2048);
    expect(opts.initialQuality).toBe(0.8);
    expect(opts.fileType).toBe("image/jpeg");
    expect(opts.preserveExif).toBe(false); // orientation baked into pixels, metadata stripped
  });

  it("converts HEIC input to a JPEG before compressing", async () => {
    const heicToJpeg = vi.fn(async () => new Blob([new Uint8Array(1500).fill(1)], { type: "image/jpeg" }));
    const compressImage = vi.fn(
      async (..._args: CompressImageArgs) => new Blob([new Uint8Array(900).fill(2)], { type: "image/jpeg" }),
    );
    const { blob } = await compress(heic(), fakeDeps({ heicToJpeg, compressImage }));

    expect(heicToJpeg).toHaveBeenCalledOnce();
    // The compressor receives the converted JPEG, renamed off the .HEIC extension.
    const passed = compressImage.mock.calls[0][0];
    expect(passed.type).toBe("image/jpeg");
    expect(passed.name).toBe("IMG_0001.jpg");
    expect(blob.type).toBe("image/jpeg");
  });

  it("skips HEIC conversion for non-HEIC input", async () => {
    const heicToJpeg = vi.fn(async () => new Blob());
    await compress(jpeg(20_000), fakeDeps({ heicToJpeg }));
    expect(heicToJpeg).not.toHaveBeenCalled();
  });

  it("hashes the ORIGINAL source bytes and is stable across calls", async () => {
    // Real sha256 — the seam is left at its default crypto.subtle impl.
    const input = jpeg(8_000);
    const a = await compress(input, fakeDeps());
    const b = await compress(input, fakeDeps());
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("derives the hash from the source, not the (re-encoded) output", async () => {
    // Same source bytes but a different compressed output → hash must not change.
    const input = jpeg(8_000);
    const a = await compress(input, fakeDeps());
    const b = await compress(input, fakeDeps({
      compressImage: vi.fn(async () => new Blob([new Uint8Array(999).fill(3)], { type: "image/jpeg" })),
    }));
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("gives different hashes for different source bytes", async () => {
    const a = await compress(jpeg(8_000, "a.jpg"), fakeDeps());
    const b = await compress(jpeg(8_001, "b.jpg"), fakeDeps());
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

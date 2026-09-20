// Generate public/icon-192.png and public/icon-512.png (FRI-21).
//
// The manifest has referenced these two files since M0 and neither existed —
// they 404'd in production. There is no raster brand asset to export from:
// the Daylight wordmark (components/ui/wordmark.tsx) is set type, "◉" +
// GATHER.PHOTO in Archivo Black. At 192px the type is unreadable, so the icon
// is the badge alone — the orange gradient rounded square with the white
// fisheye — on Daylight paper.
//
// Colors are lifted from tailwind.config.ts:
//   paper #F4E9CE · orange gradient 135deg #FF8A1E → #FF5A00 · badge white
//
// Drawn by hand into an RGBA buffer and encoded with node:zlib rather than
// pulling in a canvas/sharp dependency for two static files. Geometry is
// supersampled 4x and box-filtered down, which is what keeps the circles and
// the corner radius clean. Layout keeps all ink inside the central 80% circle
// so the 512 can be declared maskable without the badge getting clipped by an
// Android circle/squircle mask.
//
// Usage: node scripts/generate-icons.mjs   (rerun after any brand change)

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PAPER = [0xf4, 0xe9, 0xce];
const ORANGE_HI = [0xff, 0x8a, 0x1e];
const ORANGE_LO = [0xff, 0x5a, 0x00];
const WHITE = [0xff, 0xff, 0xff];

const SS = 4; // supersampling factor

/** Signed distance from a point to a rounded rectangle, negative = inside. */
function roundedRectSD(px, py, cx, cy, half, radius) {
  const dx = Math.abs(px - cx) - (half - radius);
  const dy = Math.abs(py - cy) - (half - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - radius;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Color of one supersample point, as [r,g,b]. */
function sample(x, y, size) {
  const c = size / 2;
  // Badge: 52% of the canvas, centered — corners land at 36.8% from center,
  // inside the 40% maskable safe radius.
  const badgeHalf = size * 0.26;
  const badgeRadius = badgeHalf * 0.52; // matches the wordmark's soft square

  if (roundedRectSD(x, y, c, c, badgeHalf, badgeRadius) > 0) return PAPER;

  // 135deg linear gradient across the badge (top-left hi → bottom-right lo).
  const t = Math.min(
    1,
    Math.max(0, (x - (c - badgeHalf) + (y - (c - badgeHalf))) / (4 * badgeHalf)),
  );
  const badge = mix(ORANGE_HI, ORANGE_LO, t);

  // The fisheye "◉": white annulus + white centre dot.
  const d = Math.hypot(x - c, y - c);
  const ringOuter = badgeHalf * 0.62;
  const ringInner = badgeHalf * 0.47;
  const dot = badgeHalf * 0.26;
  if (d <= dot) return WHITE;
  if (d <= ringOuter && d >= ringInner) return WHITE;
  return badge;
}

function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r * inv);
      buf[i + 1] = Math.round(g * inv);
      buf[i + 2] = Math.round(b * inv);
      buf[i + 3] = 255; // opaque: PWA icons sit on the launcher, no alpha
    }
  }
  return buf;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 10..12 = compression / filter / interlace, all 0

  // One scanline per row, each prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  const png = encodePNG(renderRGBA(size), size);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}

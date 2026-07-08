import localFont from "next/font/local";

// Self-hosted Daylight fonts (FRI-33). Latin-subset woff2 files are committed
// to the repo so `next build` never touches the network — do not switch to
// next/font/google. Fonts only load on screens that render <ScreenShell>
// (which applies these variables), so not-yet-migrated routes pay nothing.

// Archivo ships from Google Fonts as one variable file, declared 400–700.
// Handoff-review decision: the design's 500–800 weights are written as 700
// (font-bold) in code. The range clamps weights above 700, but 500/600 would
// still interpolate — so don't use font-medium/font-semibold on Daylight
// screens; use font-normal or font-bold.
export const archivo = localFont({
  src: "./fonts/archivo-latin.woff2",
  weight: "400 700",
  display: "swap",
  variable: "--font-archivo",
});

export const archivoBlack = localFont({
  src: "./fonts/archivo-black-900-latin.woff2",
  weight: "900",
  display: "swap",
  variable: "--font-archivo-black",
});

export const spaceMono = localFont({
  src: [
    { path: "./fonts/space-mono-400-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/space-mono-700-latin.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-space-mono",
});

// All three variable classes in one string, for wrappers other than
// ScreenShell (e.g. a modal portal that mounts outside the shell).
export const daylightFontVariables = `${archivo.variable} ${archivoBlack.variable} ${spaceMono.variable}`;

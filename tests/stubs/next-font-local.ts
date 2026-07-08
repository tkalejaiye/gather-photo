// Vitest stand-in for `next/font/local`, which only works inside the Next.js
// build pipeline. Page-composition tests (events.create-open.test.ts) render
// routes that mount <ScreenShell> → components/ui/fonts.ts; this stub keeps
// that render working in the plain node environment.
export default function localFont(): {
  className: string;
  variable: string;
  style: Record<string, never>;
} {
  return { className: "stub-font", variable: "stub-font-var", style: {} };
}

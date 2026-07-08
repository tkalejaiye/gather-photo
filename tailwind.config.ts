import type { Config } from "tailwindcss";

// Daylight visual system (design/daylight/README.md §Design Tokens) — warm
// film-paper light theme, orange primary, Archivo/Space Mono type. The
// `daylight-*` namespace predates FRI-36 (it coexisted with the FRI-26 dark
// theme during the migration) and is kept: it reads as the theme's name.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        daylight: {
          paper: { DEFAULT: "#F4E9CE", edge: "#ded1b6", deep: "#d3c4a6" },
          ink: { DEFAULT: "#241a0c", soft: "#6b5c3a" },
          muted: "#8a7a56",
          rule: { DEFAULT: "#d8c49a", light: "#e2d3b2" },
          orange: {
            DEFAULT: "#FF6A00",
            hi: "#FF8A1E",
            lo: "#FF5A00",
            deep: "#c85a12",
            deeper: "#e24e00",
          },
          teal: { DEFAULT: "#17B7A6", deep: "#0c5b52" },
          red: { DEFAULT: "#E8503B", deep: "#8a1c12" },
          yellow: { DEFAULT: "#E9C33C", deep: "#a3791c" },
          stamp: "#FFD9A8",
        },
      },
      fontFamily: {
        // Daylight fonts arrive as CSS variables set by <ScreenShell>
        // (components/ui/screen-shell.tsx). Routes that don't render the
        // shell (API error pages, the bare 404) fall back to the system
        // stack and load no font files.
        sans: [
          "var(--font-archivo, system-ui)",
          "-apple-system",
          "BlinkMacSystemFont",
          "\"Segoe UI\"",
          "Roboto",
          "\"Helvetica Neue\"",
          "Arial",
          "sans-serif",
        ],
        display: [
          "var(--font-archivo-black, system-ui)",
          "-apple-system",
          "BlinkMacSystemFont",
          "\"Segoe UI\"",
          "Roboto",
          "\"Helvetica Neue\"",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "var(--font-space-mono, ui-monospace)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      borderRadius: {
        "daylight-chip": "9px",
        "daylight-field": "13px",
        "daylight-btn": "14px",
        "daylight-card": "16px",
        "daylight-card-lg": "18px",
        "daylight-print": "3px",
      },
      boxShadow: {
        "daylight-btn": "0 12px 28px rgba(255,106,0,0.38)",
        "daylight-card": "0 14px 30px rgba(90,70,30,0.16)",
        "daylight-card-sm": "0 4px 12px rgba(90,70,30,0.12)",
        "daylight-print": "0 6px 15px rgba(90,70,30,0.18)",
        "daylight-print-lg": "0 12px 26px rgba(90,70,30,0.32)",
        "daylight-focus": "0 0 0 4px rgba(255,106,0,0.18)",
      },
      backgroundImage: {
        "daylight-orange-grad":
          "linear-gradient(135deg, #FF8A1E 0%, #FF5A00 100%)",
        "daylight-ambient":
          "radial-gradient(115% 82% at 6% -8%, rgba(255,138,30,0.16), transparent 52%), radial-gradient(115% 78% at 104% 0%, rgba(23,183,166,0.12), transparent 50%)",
        "daylight-backdrop":
          "radial-gradient(140% 120% at 50% -20%, #efe6d2 0%, #e2d6bd 55%, #d3c4a6 100%)",
      },
      keyframes: {
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
        "gp-fade": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "none" },
        },
        "gp-pop": {
          "0%": { opacity: "0", transform: "scale(.6)" },
          "60%": { transform: "scale(1.08)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "gp-spin": {
          to: { transform: "rotate(360deg)" },
        },
        "gp-float": {
          "0%, 100%": { transform: "translateY(0) rotate(var(--r, 0deg))" },
          "50%": { transform: "translateY(-6px) rotate(var(--r, 0deg))" },
        },
        "gp-blink": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: ".25" },
        },
      },
      animation: {
        "pulse-soft": "pulse-soft 1.4s ease-in-out infinite",
        "gp-fade": "gp-fade .35s ease both",
        "gp-pop": "gp-pop .5s ease both",
        "gp-spin": "gp-spin .9s linear infinite",
        "gp-float": "gp-float 5.5s ease-in-out infinite",
        "gp-blink": "gp-blink 1.4s infinite",
      },
    },
  },
  plugins: [],
};

export default config;

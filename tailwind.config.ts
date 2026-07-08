import type { Config } from "tailwindcss";

// FRI-26 visual system. Bold + playful — Partiful / Once energy. Dark canvas,
// plum brand + one pop accent (hot magenta), pill controls, chunky headings.
// Guest route must stay under 110 kB (TECH_SPEC §8) so we deliberately avoid
// custom fonts here and lean on a system stack + tight tracking + heavy weights.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#0E0E13",
          50: "#F5F5F7",
          100: "#E7E7EC",
          200: "#B9B9C4",
          300: "#8A8A98",
          400: "#5C5C6B",
          500: "#3D3D4A",
          600: "#26262F",
          700: "#1B1B23",
          800: "#14141B",
          900: "#0E0E13",
          950: "#08080C",
        },
        brand: { DEFAULT: "#6C3FB5", dark: "#4E2C86" },
        plum: {
          DEFAULT: "#6C3FB5",
          50: "#F3EEFB",
          100: "#E4D8F5",
          200: "#C9B0EB",
          300: "#A87FDC",
          400: "#8B57C8",
          500: "#6C3FB5",
          600: "#552E92",
          700: "#3F226E",
          800: "#2B174B",
          900: "#180C2A",
        },
        pop: {
          DEFAULT: "#FF3D8B",
          50: "#FFEAF2",
          100: "#FFCADB",
          200: "#FF97B9",
          300: "#FF6098",
          400: "#FF3D8B",
          500: "#E42574",
          600: "#B71A5D",
        },
        // FRI-33 "Daylight" tokens (design/daylight/README.md §Design Tokens).
        // Namespaced because the FRI-26 dark theme above stays live until every
        // screen migrates; the dark tokens are removed in the final Daylight
        // issue (FRI-36).
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
        // (components/ui/screen-shell.tsx). On routes that never render the
        // shell the var() fallback keeps the FRI-26 system stack, so
        // not-yet-migrated screens are unchanged and load no font files.
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
        card: "20px",
        pill: "9999px",
        "daylight-chip": "9px",
        "daylight-field": "13px",
        "daylight-btn": "14px",
        "daylight-card": "16px",
        "daylight-card-lg": "18px",
        "daylight-print": "3px",
      },
      boxShadow: {
        pop: "0 10px 30px -12px rgba(255,61,139,0.55)",
        plum: "0 10px 30px -12px rgba(108,63,181,0.55)",
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 20px 40px -20px rgba(0,0,0,0.6)",
        "daylight-btn": "0 12px 28px rgba(255,106,0,0.38)",
        "daylight-card": "0 14px 30px rgba(90,70,30,0.16)",
        "daylight-card-sm": "0 4px 12px rgba(90,70,30,0.12)",
        "daylight-print": "0 6px 15px rgba(90,70,30,0.18)",
        "daylight-print-lg": "0 12px 26px rgba(90,70,30,0.32)",
        "daylight-focus": "0 0 0 4px rgba(255,106,0,0.18)",
      },
      backgroundImage: {
        "pop-gradient":
          "linear-gradient(135deg, #FF3D8B 0%, #FF6098 45%, #8B57C8 100%)",
        "plum-gradient":
          "linear-gradient(135deg, #6C3FB5 0%, #8B57C8 100%)",
        "ink-radial":
          "radial-gradient(1200px 600px at 20% -10%, rgba(108,63,181,0.18), transparent 60%), radial-gradient(900px 500px at 100% 10%, rgba(255,61,139,0.12), transparent 55%)",
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

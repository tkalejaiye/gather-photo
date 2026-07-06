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
      },
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "\"Segoe UI\"",
          "Roboto",
          "\"Helvetica Neue\"",
          "Arial",
          "sans-serif",
        ],
        display: [
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "\"Segoe UI\"",
          "Roboto",
          "\"Helvetica Neue\"",
          "Arial",
          "sans-serif",
        ],
      },
      borderRadius: {
        card: "20px",
        pill: "9999px",
      },
      boxShadow: {
        pop: "0 10px 30px -12px rgba(255,61,139,0.55)",
        plum: "0 10px 30px -12px rgba(108,63,181,0.55)",
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 20px 40px -20px rgba(0,0,0,0.6)",
      },
      backgroundImage: {
        "pop-gradient":
          "linear-gradient(135deg, #FF3D8B 0%, #FF6098 45%, #8B57C8 100%)",
        "plum-gradient":
          "linear-gradient(135deg, #6C3FB5 0%, #8B57C8 100%)",
        "ink-radial":
          "radial-gradient(1200px 600px at 20% -10%, rgba(108,63,181,0.18), transparent 60%), radial-gradient(900px 500px at 100% 10%, rgba(255,61,139,0.12), transparent 55%)",
      },
      keyframes: {
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
      animation: {
        "pulse-soft": "pulse-soft 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;

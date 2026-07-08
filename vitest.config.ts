import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      // next/font only runs inside the Next build; page-composition tests
      // render routes that use it (via components/ui/fonts.ts).
      "next/font/local": path.resolve(__dirname, "./tests/stubs/next-font-local.ts"),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
});

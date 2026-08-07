import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/**/*.test.{ts,tsx}",
      "tests/unit/**/*.test.{ts,tsx}",
      "tests/integration/**/*.test.{ts,tsx}",
    ],
    exclude: ["tests/e2e/**", "node_modules/**"],
    // The integration suites drive real services against a real Postgres, and
    // vitest runs their files in parallel. A governed run that takes well under
    // a second on its own can still cross vitest's 5s default once two dozen
    // files are contending for the same database — which showed up as a test
    // that failed roughly one run in four on a timeout, never on an assertion.
    // The headroom removes the false negative without hiding a real hang: a
    // genuinely stuck test still fails, just later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` is a Next.js build-time guard with no runtime module.
      // Tests exercise these server modules directly, so stub it out.
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["tests/**/*.test.ts"],
    // PGlite starts a full embedded Postgres runtime per test file. Serializing
    // files keeps the default five-second test budget meaningful on local and
    // CI machines instead of turning concurrent startup contention into flakes.
    minWorkers: 1,
    maxWorkers: 1,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  }
});

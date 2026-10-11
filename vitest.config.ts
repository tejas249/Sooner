import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          // Everything that needs no database: runs on every push, inside the Vercel build gate, in a few seconds.
          name: "unit",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: ["**/*.db.test.ts", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          // Tests that need a real Postgres. Locally one is started for you (tools/dev-db); in CI it is a service
          // container named by TEST_DATABASE_URL. See src/db/testing.
          name: "db",
          include: ["src/**/*.db.test.ts", "scripts/**/*.db.test.ts"],
          exclude: ["**/node_modules/**"],
          globalSetup: ["./src/db/testing/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});

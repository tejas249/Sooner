import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Vercel's build writes files of its own into the project folder (for example .vercel/adapter-toolbar-script.js) before the
// build command runs. They are plain JavaScript that no tsconfig covers, so the type-aware lint rules crash on them and the
// build gate fails with "Oops! Something went wrong". This was found on the first deploy and cannot be reproduced without a
// file like that, so the ignore list is pinned here.
describe("ESLint ignores files that are generated rather than written", () => {
  it.each([
    ".vercel/adapter-toolbar-script.js",
    ".next/types/routes.d.ts",
    "node_modules/zod/index.js",
    "next-env.d.ts",
    ".state/poll-local.json",
    "dist/worker.mjs", // the bundled worker (npm run build:worker)
    "tools/dev-db/node_modules/pg/lib/index.js", // the dev database's own dependencies
  ])("%s", async (path) => {
    expect(await new ESLint().isPathIgnored(path)).toBe(true);
  });

  it("still lints the code we write", async () => {
    const eslint = new ESLint();
    for (const path of ["src/core/changes.ts", "src/app/page.tsx", "scripts/poll-local.ts", "src/worker/loop.ts", "src/db/migrate.ts"]) {
      expect(await eslint.isPathIgnored(path), path).toBe(false);
    }
  });
});

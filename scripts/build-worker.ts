/**
 * Bundles the worker and the migration runner into two self-contained files, so the image that runs them needs no
 * node_modules and no build tools:
 *
 *   dist/worker.mjs    the polling worker       (node dist/worker.mjs)
 *   dist/migrate.mjs   the migration runner     (node dist/migrate.mjs)
 *
 *   npm run build:worker                    writes to dist/
 *   npm run build:worker -- --outdir /tmp/x
 */
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { run } from "./lib/runtime.ts";

run(async () => {
  const { values } = parseArgs({ options: { outdir: { type: "string", default: "dist" } } });
  await build({
    entryPoints: { worker: "src/worker/index.ts", migrate: "scripts/db-migrate.ts" },
    outdir: values.outdir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: "linked",
    legalComments: "none",
    logLevel: "info",
    // pg loads its optional native binding only when asked to, which we never do.
    external: ["pg-native"],
    // The bundled CommonJS code (pg) calls require() for Node's own modules, which an ES module does not have.
    banner: { js: "import { createRequire as __sooner_createRequire } from 'node:module';\nconst require = __sooner_createRequire(import.meta.url);" },
  });
});

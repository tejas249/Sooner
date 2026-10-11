#!/usr/bin/env node
/**
 * A real Postgres for machines without Docker.
 *
 *   node tools/dev-db/serve.mjs                       a dev server that keeps its data in .state/postgres
 *   node tools/dev-db/serve.mjs --ephemeral           a throwaway server on a free port (what the database tests use)
 *   options: --data <dir>  --port <n>  --database <name>  --verbose
 *
 * Once the server accepts connections it prints one line on stdout, `READY <url>`, and stays up until it receives
 * SIGINT or SIGTERM, or (for a parent that opened a pipe on our stdin) until that parent exits. Everything else goes to
 * stderr, so a caller can read the URL from stdout without parsing anything else.
 *
 * The Postgres binaries come from the `embedded-postgres` package, installed into this folder the first time it is
 * needed. They are deliberately not one of the app's dependencies: Vercel, CI and the worker image never download them.
 * The server listens on 127.0.0.1 only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const { values } = parseArgs({
  options: {
    ephemeral: { type: "boolean", default: false },
    data: { type: "string" },
    port: { type: "string" },
    database: { type: "string", default: "sooner" },
    verbose: { type: "boolean", default: false },
  },
});

const log = (message) => process.stderr.write(`[dev-db] ${message}\n`);

function fail(message) {
  log(message);
  process.exit(1);
}

/** Asks the operating system for a port nobody is using. A small race remains, which is fine on a developer's machine. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

if (!existsSync(join(here, "node_modules", "embedded-postgres"))) {
  log("installing the database binaries (one time, about 130 MB)...");
  const install = spawnSync("npm", ["ci", "--prefix", here, "--no-audit", "--no-fund"], {
    stdio: ["ignore", process.stderr, process.stderr],
  });
  if (install.status !== 0) fail("could not install the database binaries; see the npm output above");
}

const { default: EmbeddedPostgres } = await import("embedded-postgres");

const ephemeral = values.ephemeral;
const user = "postgres";
const password = "postgres";
const dataDir = ephemeral
  ? mkdtempSync(join(tmpdir(), "sooner-pg-"))
  : resolve(repoRoot, values.data ?? ".state/postgres");
const port = values.port ? Number(values.port) : ephemeral ? await freePort() : 54329;
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`not a usable port: ${values.port}`);

if (!ephemeral) mkdirSync(dataDir, { recursive: true });
const needsInit = !existsSync(join(dataDir, "PG_VERSION"));

const postgresFlags = ["-c", "listen_addresses=127.0.0.1", "-c", "max_connections=200"];
// A throwaway server may lose its data in a crash, so it can skip the waits that make a database durable.
if (ephemeral) postgresFlags.push("-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off");

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  port,
  user,
  password,
  persistent: !ephemeral,
  initdbFlags: ["--encoding=UTF8", "--locale=en_US.UTF-8", ...(ephemeral ? ["--no-sync"] : [])],
  postgresFlags,
  onLog: (line) => values.verbose && log(String(line).trimEnd()),
  onError: (line) => values.verbose && log(String(line).trimEnd()),
});

let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  try {
    await server.stop();
  } catch (error) {
    log(`stopping the server failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (ephemeral) rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
// A test runner that dies without cleaning up must not leave a database running: its end of our stdin closes with it.
if (ephemeral) {
  process.stdin.on("end", () => void shutdown(0));
  process.stdin.on("error", () => void shutdown(0));
  process.stdin.resume();
}

try {
  if (needsInit) {
    log(`creating a new database cluster in ${ephemeral ? "a temporary folder" : dataDir}`);
    await server.initialise();
  }
  await server.start();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/address already in use|EADDRINUSE/i.test(message)) {
    fail(`port ${port} is already in use. Is the dev database already running? (npm run db:dev)`);
  }
  if (ephemeral) rmSync(dataDir, { recursive: true, force: true });
  fail(`could not start Postgres: ${message}`);
}

const database = values.database;
const admin = server.getPgClient("postgres", "127.0.0.1");
await admin.connect();
try {
  const exists = await admin.query("select 1 from pg_database where datname = $1", [database]);
  if (exists.rowCount === 0) await admin.query(`create database "${database.replaceAll('"', '""')}"`);
} finally {
  await admin.end();
}

log(ephemeral ? `throwaway Postgres on port ${port}` : `Postgres on port ${port}, data in ${dataDir}. Ctrl-C stops it.`);
process.stdout.write(`READY postgres://${user}:${password}@127.0.0.1:${port}/${database}\n`);

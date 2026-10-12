import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadMigrations, migrationStatus } from "../db/migrate.ts";
import { closePool, createPool } from "../db/pool.ts";
import { describeDatabase } from "../db/url.ts";
import { loadConfig } from "./config.ts";
import { createFetcher } from "./fetcher.ts";
import { HostGate } from "./gate.ts";
import { defaultLoopSettings, runWorker } from "./loop.ts";
import { createLogger } from "./log.ts";
import { buildUserAgent } from "./user-agent.ts";

const HELP = `Sooner worker: polls the job boards that are due and records what changed.

  node src/worker/index.ts            run until stopped (SIGTERM or Ctrl-C), then finish what is in flight and exit
  node src/worker/index.ts --once     poll what is due now, wait for it to finish, and exit
  node src/worker/index.ts --check    check the configuration and exit; connects to nothing

Environment: DATABASE_URL and HR_CONTACT are required. POLLING_ENABLED, ALL_BOARDS_FOLLOWED, DB_POOL_MAX,
SHUTDOWN_GRACE_SEC, WORKER_ID and MIGRATIONS_DIR are optional. See .env.example.
`;

export interface MainIO {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface MainDeps {
  io: MainIO;
  /** Where SIGINT and SIGTERM come from: the process, or a stand-in in a test. */
  signals: NodeJS.EventEmitter;
  /** Called on a second interrupt, to stop at once. */
  forceExit?: (code: number) => void;
  now?: () => Date;
  random?: () => number;
}

/** Runs the worker and returns the exit code. */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, deps: MainDeps): Promise<number> {
  const { io } = deps;
  let flags: { once: boolean; check: boolean; help: boolean };
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { once: { type: "boolean", default: false }, check: { type: "boolean", default: false }, help: { type: "boolean", default: false } },
    });
    flags = { once: values.once, check: values.check, help: values.help };
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }
  if (flags.help) {
    io.stdout(HELP);
    return 0;
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const userAgent = buildUserAgent(config.contact);
  if (flags.check) {
    io.stdout(
      `configuration is valid: database ${describeDatabase(config.databaseUrl)}, polling ${config.pollingEnabled ? "on" : "OFF"}, ` +
        `${config.allBoardsFollowed ? "every board followed (5 minutes)" : "priority boards every 5 minutes, the rest adaptive"}, User-Agent "${userAgent}"\n`,
    );
    return 0;
  }

  const log = createLogger((line) => io.stdout(`${line}\n`), deps.now);
  const pool = createPool(config.databaseUrl, {
    max: config.dbPoolMax,
    applicationName: `sooner-worker ${config.workerId}`.slice(0, 63),
    onError: (error) => log.warn("an idle database connection failed and was discarded", { error }),
  });

  const stop = new AbortController();
  let interrupted = false;
  const onSignal = (): void => {
    if (interrupted) {
      log.warn("interrupted again; stopping at once");
      deps.forceExit?.(130);
      return;
    }
    interrupted = true;
    log.info("stop requested; finishing the polls in flight");
    stop.abort();
  };

  try {
    try {
      // The schema is changed by `npm run db:migrate`, as its own step. A worker that is newer than its database would fail
      // in confusing ways, so it refuses to start instead. One that is older is fine: see PlanOptions.allowAhead.
      const migrations = loadMigrations(resolve(env["MIGRATIONS_DIR"] ?? "migrations"));
      const status = await migrationStatus(pool, migrations, { allowAhead: true });
      if (status.pending.length > 0) {
        log.error("the database is behind this code; run the migrations first (npm run db:migrate)", {
          pending: status.pending.map((m) => m.file),
        });
        return 1;
      }
    } catch (error) {
      log.error("cannot check the database", { error, database: describeDatabase(config.databaseUrl) });
      return 1;
    }

    deps.signals.on("SIGINT", onSignal);
    deps.signals.on("SIGTERM", onSignal);
    await runWorker(
      { pool, fetcher: createFetcher({ userAgent, gate: new HostGate() }), now: deps.now ?? (() => new Date()), random: deps.random ?? Math.random, log },
      defaultLoopSettings({
        followed: config.allBoardsFollowed,
        pollingEnabled: config.pollingEnabled,
        graceMs: config.shutdownGraceSec * 1000,
      }),
      stop.signal,
      { once: flags.once },
    );
    return 0;
  } catch (error) {
    log.error("the worker stopped because of an error", { error });
    return 1;
  } finally {
    deps.signals.off("SIGINT", onSignal);
    deps.signals.off("SIGTERM", onSignal);
    // Every way out of here closes the pool; a connection left open would keep the process alive after it has finished.
    await closePool(pool);
  }
}

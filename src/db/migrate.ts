import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "./pool.ts";

/**
 * Plain SQL migrations, applied in order, each in its own transaction.
 *
 * The files live in migrations/ and are named 0001_what_it_does.sql, 0002_..., with no gaps. Two rules keep a shared
 * database trustworthy:
 *  - An applied migration is never edited. The runner stores a checksum of every file it applied, and refuses to run if
 *    one has changed. Fix a mistake with a new migration.
 *  - Migrations run as a separate step (`npm run db:migrate`, or the deploy's release command), never when the worker
 *    starts, so an old and a new worker can overlap during a deploy.
 *
 * A file must not contain its own BEGIN or COMMIT: the runner wraps it. (That also rules out CREATE INDEX CONCURRENTLY;
 * a migration that needs it will need a runner option first.)
 */

export interface Migration {
  /** "0001" */
  version: string;
  /** "init" */
  name: string;
  /** "0001_init.sql" */
  file: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** Line endings differ between checkouts (Windows turns LF into CRLF), and that must not look like an edit. */
export const checksumOf = (sql: string): string => createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");

/** Reads and checks the migration files in `dir`. */
export function loadMigrations(dir: string): Migration[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new Error(`cannot read the migrations folder at ${dir}`);
  }
  const migrations = names
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((file): Migration => {
      const match = FILE_NAME.exec(file);
      if (!match) throw new Error(`the migration file name "${file}" must look like 0001_create_things.sql`);
      const sql = readFileSync(join(dir, file), "utf8");
      return { version: match[1] as string, name: match[2] as string, file, sql, checksum: checksumOf(sql) };
    });
  migrations.forEach((migration, index) => {
    const expected = String(index + 1).padStart(4, "0");
    if (migration.version !== expected) {
      throw new Error(
        `migrations must be numbered 0001, 0002, ... without gaps or repeats: found ${migration.file} where ${expected} was expected`,
      );
    }
  });
  return migrations;
}

export interface PlanOptions {
  /**
   * Accept migrations that are applied but unknown to this code. The migration runner never does: it must not act from an
   * older checkout than the database. A worker does, because during a deploy an old worker keeps running against a
   * database that the release step has already moved on. Migrations add things before they remove them, so that is safe.
   */
  allowAhead?: boolean;
}

/**
 * Compares what the database has applied with the files on disk and returns what still has to run. Throws when the two
 * disagree in a way that is not safe to carry on from.
 */
export function planMigrations(applied: readonly AppliedMigration[], files: readonly Migration[], options: PlanOptions = {}): Migration[] {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      if (options.allowAhead) continue;
      throw new Error(
        `the database has migration ${row.version}_${row.name} applied, but this code does not have that file. ` +
          "The database is ahead of the code: deploy the newer code, do not run migrations from an older checkout.",
      );
    }
    if (file.name !== row.name) {
      throw new Error(`migration ${row.version} was applied as "${row.name}" but the file is now called "${file.name}"`);
    }
    if (file.checksum !== row.checksum) {
      throw new Error(
        `migration ${file.file} was changed after it was applied. Never edit an applied migration; add a new one instead.`,
      );
    }
  }
  const done = new Set(applied.map((row) => row.version));
  const newest = applied.reduce((max, row) => (row.version > max ? row.version : max), "");
  const pending = files.filter((file) => !done.has(file.version));
  const behind = pending.find((file) => file.version < newest);
  if (behind && !options.allowAhead) {
    throw new Error(`migration ${behind.file} has not been applied, but a later one (${newest}) has. They must run in order.`);
  }
  return pending;
}

export interface MigrateResult {
  /** Files applied by this call, in order. */
  applied: string[];
  /** How many were already applied before it. */
  alreadyApplied: number;
}

/** An arbitrary constant that every runner agrees on, so only one of them works at a time. */
const LOCK_KEY = 7_270_011;

const ledger = `
  create table if not exists schema_migration (
    version      text primary key,
    name         text not null,
    checksum     text not null,
    applied_at   timestamptz not null default now(),
    duration_ms  int not null
  )`;

/**
 * Applies every pending migration. Safe to run twice at once: the second runner waits on an advisory lock and finds
 * nothing left to do. The lock belongs to the connection, so it disappears if the runner dies.
 */
export async function migrate(
  pool: Pool,
  migrations: readonly Migration[],
  log: (line: string) => void = () => undefined,
): Promise<MigrateResult> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      await client.query(ledger);
      const { rows } = await client.query<AppliedMigration>("select version, name, checksum from schema_migration order by version");
      const pending = planMigrations(rows, migrations);

      const applied: string[] = [];
      for (const migration of pending) {
        const started = performance.now();
        await client.query("begin");
        try {
          // Wait this long for a lock held by someone else's transaction, rather than hang a deploy behind it.
          await client.query("set local lock_timeout = '15s'");
          await client.query(migration.sql);
          await client.query(
            "insert into schema_migration (version, name, checksum, duration_ms) values ($1, $2, $3, $4)",
            [migration.version, migration.name, migration.checksum, Math.round(performance.now() - started)],
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`migration ${migration.file} failed and was rolled back: ${reason}`, { cause: error });
        }
        log(`applied ${migration.file} in ${Math.round(performance.now() - started)} ms`);
        applied.push(migration.file);
      }
      return { applied, alreadyApplied: rows.length };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch((error: unknown) => {
        broken = error instanceof Error ? error : new Error(String(error));
      });
    }
  } finally {
    client.release(broken);
  }
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: Migration[];
}

/** What `migrate` would do, without doing it and without creating anything. */
export async function migrationStatus(pool: Pool, migrations: readonly Migration[], options: PlanOptions = {}): Promise<MigrationStatus> {
  const exists = await pool.query<{ found: boolean }>("select to_regclass('schema_migration') is not null as found");
  const applied = exists.rows[0]?.found
    ? (await pool.query<AppliedMigration>("select version, name, checksum from schema_migration order by version")).rows
    : [];
  return { applied, pending: planMigrations(applied, migrations, options) };
}

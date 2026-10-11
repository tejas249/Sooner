import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { loadMigrations, migrate } from "../migrate.ts";
import { createPool, quoteIdent } from "../pool.ts";
import { startEphemeralPostgres, type RunningServer } from "./postgres.ts";
import { withDatabase } from "./urls.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** A superuser URL to a server the tests may create databases on. */
    dbAdminUrl: string;
    /** A database with every migration applied. Each test file gets a copy of it. */
    dbTemplate: string;
  }
}

const MIGRATIONS = fileURLToPath(new URL("../../../migrations/", import.meta.url));

/**
 * Runs once before the database tests. With TEST_DATABASE_URL set (CI uses a Postgres service container) it uses that
 * server; without it, it starts a throwaway one. Either way it applies the migrations once to a template database, so
 * each test file can clone a ready schema in a few milliseconds instead of migrating again.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env["TEST_DATABASE_URL"];
  const server: RunningServer | null = external ? null : await startEphemeralPostgres();
  const adminUrl = external ?? (server as RunningServer).url;

  const template = `sooner_tpl_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(template)}`);

  const pool = createPool(withDatabase(adminUrl, template), { max: 2, applicationName: "sooner-test-setup" });
  try {
    await migrate(pool, loadMigrations(MIGRATIONS));
  } finally {
    await pool.end();
  }

  project.provide("dbAdminUrl", adminUrl);
  project.provide("dbTemplate", template);

  return async () => {
    try {
      await admin.query(`drop database if exists ${quoteIdent(template)} with (force)`);
    } finally {
      await admin.end();
      await server?.stop();
    }
  };
}

import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, inject } from "vitest";
import { createPool, quoteIdent, type Pool } from "../pool.ts";
import { withDatabase } from "./urls.ts";

export interface TestDatabase {
  readonly url: string;
  readonly pool: Pool;
  /** Puts the database back to how every test starts: see `testDatabase`. */
  reset(): Promise<void>;
}

export interface TestDatabaseOptions {
  /**
   * true (the default): a copy of the migrated template, with every table empty at the start of each test.
   * false: a blank database with nothing in it, for the tests of the migration runner itself.
   */
  migrated?: boolean;
}

/**
 * Gives a database test file its own database, created before the file's tests and dropped after them. Use it at the top
 * of a `*.db.test.ts` file:
 *
 *   const db = testDatabase();
 *   it("...", async () => { await db.pool.query("select 1"); });
 *
 * Each test starts from the same place: the migrated schema with empty tables (or, with `migrated: false`, nothing).
 */
export function testDatabase(options: TestDatabaseOptions = {}): TestDatabase {
  const migrated = options.migrated ?? true;
  let name = "";
  let url = "";
  let pool: Pool | null = null;
  let admin: pg.Client | null = null;

  const current = (): Pool => {
    if (!pool) throw new Error("the test database is only available inside a test");
    return pool;
  };

  beforeAll(async () => {
    const adminUrl = inject("dbAdminUrl");
    name = `t_${randomBytes(5).toString("hex")}`;
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const from = migrated ? ` template ${quoteIdent(inject("dbTemplate"))}` : "";
    await admin.query(`create database ${quoteIdent(name)}${from}`);
    url = withDatabase(adminUrl, name);
    pool = createPool(url, { max: 12, applicationName: "sooner-test" });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${quoteIdent(name)} with (force)`);
    await admin?.end();
    pool = null;
  });

  async function reset(): Promise<void> {
    await current().query(
      migrated
        ? "truncate poll_run, posting_event, posting, board, company restart identity cascade"
        : "drop schema public cascade; create schema public",
    );
  }

  beforeEach(reset);

  return {
    get url() {
      return url;
    },
    get pool() {
      return current();
    },
    reset,
  };
}

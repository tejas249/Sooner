import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrate, migrationStatus } from "./migrate.ts";
import { testDatabase } from "./testing/database.ts";

const db = testDatabase({ migrated: false });

const folders: string[] = [];
function migrationsWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "sooner-migrations-"));
  folders.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return loadMigrations(dir);
}
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tableNames = async (): Promise<string[]> =>
  (await db.pool.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' order by 1")).rows.map(
    (r) => r.table_name,
  );

describe("the real migrations", () => {
  const real = loadMigrations(join(import.meta.dirname, "..", "..", "migrations"));

  it("apply to an empty database and create the schema", async () => {
    const result = await migrate(db.pool, real);
    expect(result.applied).toEqual(real.map((m) => m.file));
    expect(await tableNames()).toEqual(
      expect.arrayContaining(["alert_state", "board", "company", "poll_run", "posting", "posting_event", "schema_migration"]),
    );
    const extensions = await db.pool.query<{ extname: string }>("select extname from pg_extension where extname = 'pg_trgm'");
    expect(extensions.rowCount).toBe(1);
  });

  it("are recorded with their checksums, so a later edit is noticed", async () => {
    await migrate(db.pool, real);
    const { rows } = await db.pool.query<{ version: string; name: string; checksum: string }>(
      "select version, name, checksum from schema_migration order by version",
    );
    expect(rows).toEqual(real.map((m) => ({ version: m.version, name: m.name, checksum: m.checksum })));
  });

  it("do nothing the second time", async () => {
    await migrate(db.pool, real);
    const again = await migrate(db.pool, real);
    expect(again).toEqual({ applied: [], alreadyApplied: real.length });
  });
});

describe("migrate", () => {
  it("applies migrations in order, one transaction each", async () => {
    const migrations = migrationsWith({
      "0001_first.sql": "create table first (id int primary key);",
      "0002_second.sql": "create table second (id int references first(id)); insert into first values (1);",
    });
    const result = await migrate(db.pool, migrations);
    expect(result.applied).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect((await db.pool.query("select count(*)::int as n from first")).rows[0]).toEqual({ n: 1 });
  });

  it("picks up only the new file when one is added later", async () => {
    await migrate(db.pool, migrationsWith({ "0001_first.sql": "create table first (id int);" }));
    const result = await migrate(
      db.pool,
      migrationsWith({ "0001_first.sql": "create table first (id int);", "0002_second.sql": "create table second (id int);" }),
    );
    expect(result).toEqual({ applied: ["0002_second.sql"], alreadyApplied: 1 });
  });

  it("rolls a failing migration back completely and records nothing for it", async () => {
    const migrations = migrationsWith({
      "0001_first.sql": "create table first (id int);",
      "0002_broken.sql": "create table half_done (id int); select 1 / 0;",
    });
    await expect(migrate(db.pool, migrations)).rejects.toThrow(/0002_broken\.sql failed and was rolled back.*division by zero/);
    expect(await tableNames()).toEqual(["first", "schema_migration"]);
    const { rows } = await db.pool.query<{ version: string }>("select version from schema_migration");
    expect(rows.map((r) => r.version)).toEqual(["0001"]);
  });

  it("can be fixed and run again after a failure", async () => {
    await expect(
      migrate(db.pool, migrationsWith({ "0001_first.sql": "create table first (id int); select 1 / 0;" })),
    ).rejects.toThrow(/failed/);
    // The author fixes the file. It was never applied, so editing it is fine.
    const result = await migrate(db.pool, migrationsWith({ "0001_first.sql": "create table first (id int);" }));
    expect(result.applied).toEqual(["0001_first.sql"]);
  });

  it("refuses to run when an applied migration was edited", async () => {
    await migrate(db.pool, migrationsWith({ "0001_first.sql": "create table first (id int);" }));
    await expect(
      migrate(db.pool, migrationsWith({ "0001_first.sql": "create table first (id int, extra text);" })),
    ).rejects.toThrow(/was changed after it was applied/);
  });

  it("refuses to run from code that is older than the database", async () => {
    await migrate(
      db.pool,
      migrationsWith({ "0001_first.sql": "create table first (id int);", "0002_second.sql": "create table second (id int);" }),
    );
    await expect(migrate(db.pool, migrationsWith({ "0001_first.sql": "create table first (id int);" }))).rejects.toThrow(
      /database is ahead of the code/,
    );
  });

  it("lets two runners start at once: one applies, the other waits and finds nothing to do", async () => {
    const migrations = migrationsWith({
      "0001_slow.sql": "select pg_sleep(0.4); create table slow (id int);",
      "0002_after.sql": "create table after (id int);",
    });
    const results = await Promise.all(Array.from({ length: 4 }, () => migrate(db.pool, migrations)));
    const appliedBy = results.filter((r) => r.applied.length > 0);
    expect(appliedBy).toHaveLength(1);
    expect(appliedBy[0]?.applied).toEqual(["0001_slow.sql", "0002_after.sql"]);
    expect(results.filter((r) => r.applied.length === 0).every((r) => r.alreadyApplied === 2)).toBe(true);
    expect((await db.pool.query("select count(*)::int as n from schema_migration")).rows[0]).toEqual({ n: 2 });
  });

  it("releases its lock, so a later run is not blocked", async () => {
    const migrations = migrationsWith({ "0001_first.sql": "create table first (id int);" });
    await migrate(db.pool, migrations);
    // pg_locks covers the whole server, and tests in other databases take the same advisory lock at the same time, so
    // look only at this database's.
    const { rows } = await db.pool.query<{ locks: number }>(
      `select count(*)::int as locks from pg_locks
        where locktype = 'advisory' and objid = 7270011
          and database = (select oid from pg_database where datname = current_database())`,
    );
    expect(rows[0]?.locks).toBe(0);
  });

  it("logs each migration it applies", async () => {
    const lines: string[] = [];
    await migrate(db.pool, migrationsWith({ "0001_first.sql": "create table first (id int);" }), (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^applied 0001_first\.sql in \d+ ms$/);
  });
});

describe("migrationStatus", () => {
  it("reports everything as pending on a blank database without creating anything", async () => {
    const migrations = migrationsWith({ "0001_first.sql": "create table first (id int);" });
    const status = await migrationStatus(db.pool, migrations);
    expect(status.applied).toEqual([]);
    expect(status.pending.map((m) => m.file)).toEqual(["0001_first.sql"]);
    expect(await tableNames()).toEqual([]);
  });

  it("reports what has been applied and what is still waiting", async () => {
    await migrate(db.pool, migrationsWith({ "0001_first.sql": "create table first (id int);" }));
    const status = await migrationStatus(
      db.pool,
      migrationsWith({ "0001_first.sql": "create table first (id int);", "0002_second.sql": "create table second (id int);" }),
    );
    expect(status.applied.map((m) => m.version)).toEqual(["0001"]);
    expect(status.pending.map((m) => m.file)).toEqual(["0002_second.sql"]);
  });
});

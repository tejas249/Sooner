import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checksumOf, loadMigrations, planMigrations, type AppliedMigration, type Migration } from "./migrate.ts";

const folders: string[] = [];
function folderWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sooner-migrations-"));
  folders.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const file = (version: string, name: string, sql = "select 1"): Migration => ({
  version,
  name,
  file: `${version}_${name}.sql`,
  sql,
  checksum: checksumOf(sql),
});
const applied = (m: Migration): AppliedMigration => ({ version: m.version, name: m.name, checksum: m.checksum });

describe("loadMigrations", () => {
  it("reads the real migrations folder: numbered 0001 upward, no gaps", () => {
    const migrations = loadMigrations(join(import.meta.dirname, "..", "..", "migrations"));
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_, i) => String(i + 1).padStart(4, "0")));
    expect(migrations[0]?.file).toBe("0001_init.sql");
  });

  it("returns the files in order with their names and checksums", () => {
    const dir = folderWith({ "0002_add_things.sql": "select 2", "0001_init.sql": "select 1", "notes.txt": "ignored" });
    const migrations = loadMigrations(dir);
    expect(migrations.map((m) => [m.version, m.name])).toEqual([
      ["0001", "init"],
      ["0002", "add_things"],
    ]);
    expect(migrations[0]?.checksum).toBe(checksumOf("select 1"));
  });

  it("refuses a file name that is not 0001_snake_case.sql", () => {
    for (const bad of ["1_init.sql", "0001-init.sql", "0001_Init.sql", "0001_.sql", "init.sql"]) {
      expect(() => loadMigrations(folderWith({ [bad]: "select 1" }))).toThrow(/must look like 0001_create_things\.sql/);
    }
  });

  it("refuses gaps, repeats and a missing start", () => {
    expect(() => loadMigrations(folderWith({ "0001_a.sql": "x", "0003_c.sql": "x" }))).toThrow(/0002 was expected/);
    expect(() => loadMigrations(folderWith({ "0001_a.sql": "x", "0001_b.sql": "x" }))).toThrow(/0002 was expected/);
    expect(() => loadMigrations(folderWith({ "0002_b.sql": "x" }))).toThrow(/0001 was expected/);
  });

  it("says so when the folder does not exist", () => {
    const dir = folderWith({});
    expect(() => loadMigrations(join(dir, "missing"))).toThrow(/cannot read the migrations folder/);
  });

  it("does not mistake a subfolder for a migration", () => {
    const dir = folderWith({ "0001_a.sql": "x" });
    mkdirSync(join(dir, "archive"));
    expect(loadMigrations(dir)).toHaveLength(1);
  });
});

describe("checksumOf", () => {
  it("is the same for the same text and different for an edit", () => {
    expect(checksumOf("create table a ();")).toBe(checksumOf("create table a ();"));
    expect(checksumOf("create table a ();")).not.toBe(checksumOf("create table b ();"));
  });

  it("ignores the line ending, so a Windows checkout does not look like an edit", () => {
    expect(checksumOf("a\r\nb\r\n")).toBe(checksumOf("a\nb\n"));
  });
});

describe("planMigrations", () => {
  const one = file("0001", "init");
  const two = file("0002", "add_things");
  const three = file("0003", "more");

  it("everything is pending on an empty database", () => {
    expect(planMigrations([], [one, two])).toEqual([one, two]);
  });

  it("nothing is pending once everything has been applied", () => {
    expect(planMigrations([applied(one), applied(two)], [one, two])).toEqual([]);
  });

  it("only the new files are pending", () => {
    expect(planMigrations([applied(one)], [one, two, three])).toEqual([two, three]);
  });

  it("refuses to run when an applied migration was edited", () => {
    const edited = file("0001", "init", "select 'something else'");
    expect(() => planMigrations([applied(one)], [edited])).toThrow(/0001_init\.sql was changed after it was applied/);
  });

  it("refuses to run when it was renamed", () => {
    expect(() => planMigrations([applied(one)], [file("0001", "start", one.sql)])).toThrow(/now called "start"/);
  });

  it("refuses to run when the database is ahead of the code", () => {
    expect(() => planMigrations([applied(one), applied(two)], [one])).toThrow(/database is ahead of the code/);
  });

  it("refuses to run a migration that is older than one already applied", () => {
    expect(() => planMigrations([applied(one), applied(three)], [one, two, three])).toThrow(/must run in order/);
  });

  describe("for a worker that may be older than the database (allowAhead)", () => {
    const options = { allowAhead: true };

    it("ignores migrations that are applied but unknown to this code", () => {
      expect(planMigrations([applied(one), applied(two)], [one], options)).toEqual([]);
    });

    it("still reports what this code needs and the database lacks", () => {
      expect(planMigrations([applied(two)], [one, two], options)).toEqual([one]);
      expect(planMigrations([], [one, two], options)).toEqual([one, two]);
    });

    it("still refuses a migration that was edited after it was applied", () => {
      const edited = file("0001", "init", "select 'something else'");
      expect(() => planMigrations([applied(one), applied(two)], [edited], options)).toThrow(/was changed after it was applied/);
    });
  });
});

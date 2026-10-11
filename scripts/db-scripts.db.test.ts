import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../src/db/testing/database.ts";
import { waitFor } from "../src/worker/testing.ts";

const exec = promisify(execFile);

/** A clean environment for a child program: only what a test names, so nothing from this machine's .env leaks in. */
const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "production", PATH: process.env["PATH"] ?? "", ...extra });

interface Result {
  code: number;
  output: string;
}

/** Runs a program the way a person or a deploy would, and returns its exit code and everything it printed. */
async function run(file: string, args: string[], env: Record<string, string>, cwd = process.cwd()): Promise<Result> {
  try {
    const { stdout, stderr } = await exec(file, args, { cwd, env: childEnv(env), timeout: 60_000 });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}
const node = (args: string[], env: Record<string, string>, cwd?: string) => run(process.execPath, args, env, cwd);
const ESCAPE = String.fromCharCode(27);
const plain = (text: string) => text.replace(new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g"), "");

describe("npm run db:migrate", () => {
  const blank = testDatabase({ migrated: false });
  const env = () => ({ DATABASE_URL: blank.url });

  it("applies the migrations, and says so", async () => {
    const result = await node(["scripts/db-migrate.ts"], env());
    expect(result.code).toBe(0);
    expect(plain(result.output)).toMatch(/applied 0001_init\.sql in \d+ ms/);
    expect(plain(result.output)).toMatch(/Applied 1 migration\./);
  });

  it("finds nothing to do the second time", async () => {
    await node(["scripts/db-migrate.ts"], env());
    const again = await node(["scripts/db-migrate.ts"], env());
    expect(again.code).toBe(0);
    expect(plain(again.output)).toMatch(/Up to date: all 1 migrations were already applied/);
  });

  it("shows what is pending with --status, and changes nothing", async () => {
    const before = await node(["scripts/db-migrate.ts", "--status"], env());
    expect(plain(before.output)).toMatch(/pending\s+0001_init\.sql/);
    expect(plain(before.output)).toMatch(/0 applied, 1 pending/);
    const tables = await blank.pool.query("select to_regclass('company') as company");
    expect(tables.rows[0]).toEqual({ company: null });

    await node(["scripts/db-migrate.ts"], env());
    const after = await node(["scripts/db-migrate.ts", "--status"], env());
    expect(plain(after.output)).toMatch(/applied\s+0001_init\.sql/);
    expect(plain(after.output)).toMatch(/1 applied, 0 pending/);
  });

  it("names the database it is about to change, without its password", async () => {
    const url = new URL(blank.url);
    const result = await node(["scripts/db-migrate.ts", "--status"], env());
    expect(result.output).toContain(`${url.hostname}:${url.port}${url.pathname}`);
    expect(result.output).not.toContain(url.password === "" ? "\u0000" : url.password + "@");
  });

  it("explains how to get a database when DATABASE_URL is missing", async () => {
    const result = await node(["scripts/db-migrate.ts"], {});
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/DATABASE_URL is not set.*npm run db:dev/s);
  });

  it("does not leak the password when the database cannot be reached", async () => {
    const result = await node(["scripts/db-migrate.ts"], { DATABASE_URL: "postgres://user:secretpw@127.0.0.1:1/nothing" });
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("secretpw");
  });
});

describe("npm run db:seed", () => {
  const db = testDatabase();
  const env = () => ({ DATABASE_URL: db.url });

  it("seeds the 50 boards, and a second run adds nothing", async () => {
    const first = await node(["scripts/db-seed.ts"], env());
    expect(first.code).toBe(0);
    expect(plain(first.output)).toMatch(/companies: 50 added, 0 updated/);
    expect(plain(first.output)).toMatch(/boards:\s+50 added \(first polls spread over 1m\), 0 already there/);

    const second = await node(["scripts/db-seed.ts"], env());
    expect(plain(second.output)).toMatch(/companies: 0 added, 0 updated/);
    expect(plain(second.output)).toMatch(/boards:\s+0 added, 50 already there/);
    const { rows } = await db.pool.query<{ n: number }>("select count(*)::int as n from board");
    expect(rows[0]?.n).toBe(50);
  });

  it("refuses a spread that is not a duration", async () => {
    const result = await node(["scripts/db-seed.ts", "--spread", "soon"], env());
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/not a duration/);
  });

  it("refuses a boards file that is not in the expected format, and touches nothing", async () => {
    const result = await node(["scripts/db-seed.ts", "--boards", "package.json"], env());
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/is not in the expected format/);
    const { rows } = await db.pool.query<{ n: number }>("select count(*)::int as n from company");
    expect(rows[0]?.n).toBe(0);
  });
});

describe("the bundled worker", () => {
  const blank = testDatabase({ migrated: false });
  let dir = "";
  let bundle = "";

  beforeAll(async () => {
    // Everything the image will have, and nothing else: no node_modules, no source.
    dir = mkdtempSync(join(tmpdir(), "sooner-bundle-"));
    bundle = join(dir, "dist");
    const built = await node(["scripts/build-worker.ts", "--outdir", bundle], {});
    expect(built.code, built.output).toBe(0);
    cpSync("migrations", join(dir, "migrations"), { recursive: true });
    mkdirSync(join(dir, "empty"));
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const env = () => ({ DATABASE_URL: blank.url, HR_CONTACT: "https://example.com/bot" });

  it("is two files that need no node_modules", () => {
    expect(existsSync(join(bundle, "worker.mjs"))).toBe(true);
    expect(existsSync(join(bundle, "migrate.mjs"))).toBe(true);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  it("checks its own configuration", async () => {
    const result = await node([join(bundle, "worker.mjs"), "--check"], env(), dir);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/configuration is valid/);
  });

  it("migrates a database, then refuses to start before that and starts after it", async () => {
    const early = await node([join(bundle, "worker.mjs"), "--once"], env(), dir);
    expect(early.code).toBe(1);
    expect(early.output).toMatch(/run the migrations first/);

    const migrated = await node([join(bundle, "migrate.mjs")], env(), dir);
    expect(migrated.code, migrated.output).toBe(0);
    expect(plain(migrated.output)).toMatch(/Applied 1 migration\./);

    const started = await node([join(bundle, "worker.mjs"), "--once"], env(), dir);
    expect(started.code, started.output).toBe(0);
    expect(started.output).toMatch(/"msg":"worker stopped"/);
  });

  it("stops cleanly on SIGTERM", async () => {
    await node([join(bundle, "migrate.mjs")], env(), dir);
    const child = spawn(process.execPath, [join(bundle, "worker.mjs")], { cwd: dir, env: childEnv(env()) });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    await waitFor(() => output.includes('"msg":"worker started"'), "the bundled worker to start");
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(0);
    expect(output).toMatch(/"msg":"stop requested; finishing the polls in flight"/);
    expect(output).toMatch(/"msg":"worker stopped"/);
  });
});

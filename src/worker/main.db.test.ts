import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate } from "../db/migrate.ts";
import { testDatabase } from "../db/testing/database.ts";
import { main, type MainDeps } from "./main.ts";
import { waitFor } from "./testing.ts";

function setup() {
  const out: string[] = [];
  const err: string[] = [];
  const signals = new EventEmitter();
  const deps: MainDeps = { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, signals };
  const logs = () => out.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { level: string; msg: string; [k: string]: unknown });
  return { out, err, deps, signals, logs };
}

describe("main, against a database that has been migrated", () => {
  const db = testDatabase();
  const env = () => ({ DATABASE_URL: db.url, HR_CONTACT: "https://example.com/bot" });

  it("with --once and nothing due, starts, finds nothing to do and exits cleanly", async () => {
    const { deps, logs } = setup();
    expect(await main(["--once"], env(), deps)).toBe(0);
    expect(logs().map((l) => l.msg)).toEqual(["worker started", "worker stopped"]);
  });

  it("stops cleanly on SIGTERM: stops claiming, finishes, and exits 0", async () => {
    const { deps, signals, logs } = setup();
    const running = main([], env(), deps);
    await waitFor(() => signals.listenerCount("SIGTERM") > 0, "the worker to be listening for SIGTERM");
    signals.emit("SIGTERM");
    expect(await running).toBe(0);
    expect(logs().map((l) => l.msg)).toEqual(expect.arrayContaining(["worker started", "stop requested; finishing the polls in flight", "worker stopped"]));
    expect(signals.listenerCount("SIGTERM")).toBe(0); // it cleaned up after itself
  });

  it("stops at once on a second interrupt", async () => {
    const { deps, signals } = setup();
    const exits: number[] = [];
    const running = main([], env(), { ...deps, forceExit: (code) => exits.push(code) });
    await waitFor(() => signals.listenerCount("SIGINT") > 0, "the worker to be listening for SIGINT");
    signals.emit("SIGINT");
    signals.emit("SIGINT");
    await running;
    expect(exits).toEqual([130]);
  });

  it("does not poll when polling is switched off", async () => {
    const { deps, logs } = setup();
    expect(await main(["--once"], { ...env(), POLLING_ENABLED: "false" }, deps)).toBe(0);
    expect(logs().some((l) => l.level === "warn" && /POLLING_ENABLED=false/.test(l.msg))).toBe(true);
  });
});

describe("main, against a database that is not ready", () => {
  const blank = testDatabase({ migrated: false });

  it("refuses to start while migrations are pending, and says how to fix it", async () => {
    const { deps, logs } = setup();
    expect(await main(["--once"], { DATABASE_URL: blank.url, HR_CONTACT: "https://example.com/bot" }, deps)).toBe(1);
    const error = logs().find((l) => l.level === "error");
    expect(error?.msg).toMatch(/behind this code; run the migrations first \(npm run db:migrate\)/);
    expect(error?.["pending"]).toEqual(["0001_init.sql"]);
  });

  it("starts once the migrations have been applied", async () => {
    await migrate(blank.pool, loadMigrations("migrations"));
    const { deps } = setup();
    expect(await main(["--once"], { DATABASE_URL: blank.url, HR_CONTACT: "https://example.com/bot" }, deps)).toBe(0);
  });

  it("still starts when the database is ahead of the code, as during a rolling deploy", async () => {
    const real = loadMigrations("migrations");
    const newer = mkdtempSync(join(tmpdir(), "sooner-newer-"));
    try {
      for (const m of real) writeFileSync(join(newer, m.file), m.sql);
      writeFileSync(join(newer, "0002_something_new.sql"), "select 1;");
      await migrate(blank.pool, loadMigrations(newer));
      const { deps } = setup();
      expect(await main(["--once"], { DATABASE_URL: blank.url, HR_CONTACT: "https://example.com/bot" }, deps)).toBe(0);
    } finally {
      rmSync(newer, { recursive: true, force: true });
    }
  });

  it("exits non-zero, without printing the password, when the database cannot be reached", async () => {
    const { deps, out, err } = setup();
    const code = await main(["--once"], { DATABASE_URL: "postgres://user:secretpw@127.0.0.1:1/nothing", HR_CONTACT: "https://example.com/bot" }, deps);
    expect(code).toBe(1);
    expect(out.join("") + err.join("")).toMatch(/cannot check the database/);
    expect(out.join("") + err.join("")).not.toContain("secretpw");
  });
});

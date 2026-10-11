import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const valid = { DATABASE_URL: "postgres://u:p@db.example.com:5432/sooner", HR_CONTACT: "https://example.com/bot" };

describe("loadConfig", () => {
  it("needs only a database and a contact, and defaults the rest", () => {
    const config = loadConfig(valid);
    expect(config).toMatchObject({
      databaseUrl: valid.DATABASE_URL,
      contact: valid.HR_CONTACT,
      pollingEnabled: true,
      allBoardsFollowed: true,
      dbPoolMax: 10,
      shutdownGraceSec: 25,
    });
    expect(config.workerId.length).toBeGreaterThan(0);
  });

  it("reads the optional settings", () => {
    const config = loadConfig({
      ...valid,
      POLLING_ENABLED: "false",
      ALL_BOARDS_FOLLOWED: "0",
      DB_POOL_MAX: "4",
      SHUTDOWN_GRACE_SEC: "60",
      WORKER_ID: "fly-1",
    });
    expect(config).toMatchObject({ pollingEnabled: false, allBoardsFollowed: false, dbPoolMax: 4, shutdownGraceSec: 60, workerId: "fly-1" });
  });

  it("accepts true and false in any case, and ignores empty values", () => {
    expect(loadConfig({ ...valid, POLLING_ENABLED: "TRUE" }).pollingEnabled).toBe(true);
    expect(loadConfig({ ...valid, POLLING_ENABLED: "False" }).pollingEnabled).toBe(false);
    expect(loadConfig({ ...valid, POLLING_ENABLED: "", DB_POOL_MAX: " " }).pollingEnabled).toBe(true);
  });

  it("reports every problem at once", () => {
    let message = "";
    try {
      loadConfig({ POLLING_ENABLED: "maybe", DB_POOL_MAX: "1000", SHUTDOWN_GRACE_SEC: "soon" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not configured correctly/);
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/HR_CONTACT/);
    expect(message).toMatch(/POLLING_ENABLED must be true or false/);
    expect(message).toMatch(/DB_POOL_MAX must be a whole number from 2 to 50/);
    expect(message).toMatch(/SHUTDOWN_GRACE_SEC must be a whole number from 1 to 300/);
  });

  it("refuses a contact that cannot go into a User-Agent", () => {
    expect(() => loadConfig({ ...valid, HR_CONTACT: "bad (contact)" })).toThrow(/HR_CONTACT must be one line/);
    expect(() => loadConfig({ ...valid, HR_CONTACT: "   " })).toThrow(/HR_CONTACT is empty/);
  });

  it("never puts the database password into an error", () => {
    let message = "";
    try {
      loadConfig({ DATABASE_URL: "mysql://user:hunter2@host/db", HR_CONTACT: "x@example.com" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain("hunter2");
  });
});

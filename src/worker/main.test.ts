import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { main, type MainDeps } from "./main.ts";

function setup() {
  const out: string[] = [];
  const err: string[] = [];
  const deps: MainDeps = { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, signals: new EventEmitter() };
  return { out, err, deps };
}

const env = { DATABASE_URL: "postgres://user:secretpw@db.example.com:5432/sooner", HR_CONTACT: "https://example.com/bot" };

describe("main", () => {
  it("prints its usage for --help", async () => {
    const { out, deps } = setup();
    expect(await main(["--help"], {}, deps)).toBe(0);
    expect(out.join("")).toMatch(/--once/);
    expect(out.join("")).toMatch(/--check/);
  });

  it("rejects an option it does not know, with the usage", async () => {
    const { err, deps } = setup();
    expect(await main(["--wat"], env, deps)).toBe(2);
    expect(err.join("")).toMatch(/--wat/);
    expect(err.join("")).toMatch(/--once/);
  });

  it("says what is missing from the environment and exits non-zero", async () => {
    const { err, deps } = setup();
    expect(await main([], {}, deps)).toBe(1);
    expect(err.join("")).toMatch(/DATABASE_URL/);
    expect(err.join("")).toMatch(/HR_CONTACT/);
  });

  it("checks the configuration with --check, without connecting to anything, and does not print the password", async () => {
    const { out, deps } = setup();
    expect(await main(["--check"], env, deps)).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/configuration is valid: database db\.example\.com:5432\/sooner, polling on/);
    expect(text).toMatch(/User-Agent "Sooner\/0\.1 \(\+https:\/\/example\.com\/bot\)"/);
    expect(text).not.toContain("secretpw");
  });

  it("says where alerts go, without the address", async () => {
    const logged = setup();
    await main(["--check"], env, logged.deps);
    expect(logged.out.join("")).toMatch(/alerts logged only/);

    const hook = setup();
    await main(["--check"], { ...env, ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/123/very-secret-token" }, hook.deps);
    expect(hook.out.join("")).toMatch(/alerts to discord/);
    expect(hook.out.join("")).not.toContain("very-secret-token");

    expect(logged.out.join("")).toMatch(/heartbeat off/);
    const beating = setup();
    await main(["--check"], { ...env, HEARTBEAT_URL: "https://hc-ping.com/very-secret-uuid" }, beating.deps);
    expect(beating.out.join("")).toMatch(/heartbeat on/);
    expect(beating.out.join("")).not.toContain("very-secret-uuid");

    const telegram = setup();
    await main(["--check"], { ...env, ALERT_TELEGRAM_BOT_TOKEN: "1:secret-bot-token", ALERT_TELEGRAM_CHAT_ID: "-100" }, telegram.deps);
    expect(telegram.out.join("")).toMatch(/alerts to telegram/);
    expect(telegram.out.join("")).not.toContain("secret-bot-token");
  });

  it("says when polling is switched off", async () => {
    const { out, deps } = setup();
    await main(["--check"], { ...env, POLLING_ENABLED: "false" }, deps);
    expect(out.join("")).toMatch(/polling OFF/);
  });
});

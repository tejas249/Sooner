import { describe, expect, it } from "vitest";
import type { Notice } from "../core/health.ts";
import { GONE_REASON } from "../core/health.ts";
import { openAlerts } from "../db/alerts.ts";
import { testDatabase } from "../db/testing/database.ts";
import { insertBoard, insertCompany, insertPosting } from "../db/testing/factories.ts";
import { createMemoryLogger } from "./log.ts";
import { checkOnce, runMonitor, type MonitorDeps } from "./monitor.ts";
import type { Notifier } from "./notify.ts";
import { waitFor } from "./testing.ts";

const db = testDatabase();
const NOW = new Date("2026-10-12T12:00:00Z");
const at = (seconds: number): string => new Date(NOW.getTime() + seconds * 1000).toISOString();

interface FakeNotifier extends Notifier {
  sent: Notice[][];
  failing: boolean;
}
function fakeNotifier(): FakeNotifier {
  const fake: FakeNotifier = {
    channel: "fake",
    sent: [],
    failing: false,
    send(notices) {
      if (fake.failing) return Promise.reject(new Error("the alert channel answered HTTP 500"));
      fake.sent.push([...notices]);
      return Promise.resolve();
    },
  };
  return fake;
}

function setup(over: Partial<MonitorDeps> = {}) {
  const { logger, entries } = createMemoryLogger();
  const clock = { now: NOW };
  const deps: MonitorDeps = { pool: db.pool, notifier: null, log: logger, now: () => clock.now, ...over };
  return { deps, entries, clock };
}

async function overdueBoard(lagSec: number) {
  const company = await insertCompany(db.pool, { slug: "acme", name: "Acme" });
  return insertBoard(db.pool, company, { nextPollAt: at(-lagSec) });
}

describe("checkOnce", () => {
  it("has nothing to say about a healthy system", async () => {
    const notifier = fakeNotifier();
    await overdueBoard(10);
    const { deps } = setup({ notifier });
    expect(await checkOnce(deps)).toEqual({ problems: 0, opened: [], resolved: [], delivered: 0, deliveryFailed: false });
    expect(notifier.sent).toEqual([]);
    expect(await openAlerts(db.pool)).toEqual([]);
  });

  it("opens an alert for a board that is polled late, tells the owner once, and logs it", async () => {
    const notifier = fakeNotifier();
    await overdueBoard(900);
    const { deps, entries } = setup({ notifier });

    const report = await checkOnce(deps);
    expect(report).toMatchObject({ problems: 1, opened: ["queue-lag"], delivered: 1, deliveryFailed: false });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject([{ kind: "new", key: "queue-lag", severity: "critical" }]);
    expect(entries.filter((e) => e.msg === "alert")).toMatchObject([{ level: "error", key: "queue-lag", severity: "critical" }]);
    expect(await openAlerts(db.pool)).toMatchObject([{ key: "queue-lag", sendCount: 1 }]);
  });

  it("stays quiet while the problem lasts, until it is time for a reminder", async () => {
    const notifier = fakeNotifier();
    await overdueBoard(900);
    const { deps, clock } = setup({ notifier });
    await checkOnce(deps);

    for (const minutes of [1, 2, 30, 59]) {
      clock.now = new Date(NOW.getTime() + minutes * 60_000);
      expect(await checkOnce(deps)).toMatchObject({ delivered: 0, opened: [] });
    }
    expect(notifier.sent).toHaveLength(1);

    clock.now = new Date(NOW.getTime() + 61 * 60_000);
    expect(await checkOnce(deps)).toMatchObject({ delivered: 1 });
    expect(notifier.sent[1]).toMatchObject([{ kind: "reminder", key: "queue-lag" }]);
  });

  it("says when the problem is over", async () => {
    const notifier = fakeNotifier();
    const board = await overdueBoard(900);
    const { deps, entries, clock } = setup({ notifier });
    await checkOnce(deps);

    await db.pool.query("update board set next_poll_at = $1 where id = $2", [at(600), board]);
    clock.now = new Date(NOW.getTime() + 120_000);
    const report = await checkOnce(deps);
    expect(report).toMatchObject({ problems: 0, resolved: ["queue-lag"], delivered: 1 });
    expect(notifier.sent[1]).toMatchObject([{ kind: "resolved", key: "queue-lag" }]);
    expect(entries.some((e) => e.msg === "alert resolved" && e["key"] === "queue-lag")).toBe(true);
    expect(await openAlerts(db.pool)).toEqual([]);
  });

  it("offers the notices again, and logs a warning, when the channel is down; then delivers them when it is back", async () => {
    const notifier = fakeNotifier();
    notifier.failing = true;
    await overdueBoard(900);
    const { deps, entries, clock } = setup({ notifier });

    expect(await checkOnce(deps)).toMatchObject({ opened: ["queue-lag"], delivered: 0, deliveryFailed: true });
    expect(entries.some((e) => e.level === "warn" && /could not deliver alerts/.test(e.msg))).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("http");

    notifier.failing = false;
    clock.now = new Date(NOW.getTime() + 60_000);
    const retry = await checkOnce(deps);
    expect(retry).toMatchObject({ opened: [], delivered: 1, deliveryFailed: false });
    expect(notifier.sent).toHaveLength(1);
    expect(entries.filter((e) => e.msg === "alert")).toHaveLength(1); // logged when it opened, not on every offer
  });

  it("tracks and logs alerts even with no channel configured, and tells the owner as soon as one is", async () => {
    await overdueBoard(900);
    const { deps, entries, clock } = setup({ notifier: null });
    expect(await checkOnce(deps)).toMatchObject({ problems: 1, opened: ["queue-lag"], delivered: 0, deliveryFailed: false });
    clock.now = new Date(NOW.getTime() + 60_000);
    await checkOnce(deps);
    expect(entries.filter((e) => e.msg === "alert")).toHaveLength(1);
    expect(await openAlerts(db.pool)).toHaveLength(1);

    const notifier = fakeNotifier();
    clock.now = new Date(NOW.getTime() + 120_000);
    expect(await checkOnce({ ...deps, notifier })).toMatchObject({ delivered: 1 });
    expect(notifier.sent[0]).toMatchObject([{ kind: "new", key: "queue-lag" }]);
  });

  it("uses the open alert to clear at a lower threshold than it opens at", async () => {
    const notifier = fakeNotifier();
    const board = await overdueBoard(900);
    const { deps, clock } = setup({ notifier });
    await checkOnce(deps);

    // 250 seconds behind is under the 300 that raised the alert, but not yet under the 120 that clears it.
    await db.pool.query("update board set next_poll_at = $1 where id = $2", [at(60 - 250), board]);
    clock.now = new Date(NOW.getTime() + 60_000);
    expect(await checkOnce(deps)).toMatchObject({ problems: 1, resolved: [] });

    await db.pool.query("update board set next_poll_at = $1 where id = $2", [at(120 - 100), board]);
    clock.now = new Date(NOW.getTime() + 120_000);
    expect(await checkOnce(deps)).toMatchObject({ problems: 0, resolved: ["queue-lag"] });
  });

  describe("one board", () => {
    it("tells the owner when a board was switched off for answering 404, and says which", async () => {
      const notifier = fakeNotifier();
      const company = await insertCompany(db.pool, { slug: "acme", name: "Acme" });
      const board = await insertBoard(db.pool, company, { active: false, deactivatedReason: GONE_REASON, nextPollAt: at(600) });
      const { deps } = setup({ notifier });
      await checkOnce(deps);
      expect(notifier.sent[0]).toMatchObject([{ kind: "new", key: `board:${board}:gone`, severity: "warning", title: "Acme was switched off" }]);
    });

    it("does not bother the owner about a board they paused themselves", async () => {
      const notifier = fakeNotifier();
      const company = await insertCompany(db.pool);
      await insertBoard(db.pool, company, { active: false, deactivatedReason: "opt-out requested", nextPollAt: at(600) });
      expect(await checkOnce(setup({ notifier }).deps)).toMatchObject({ problems: 0 });
    });

    it("tells the owner when a feed changed shape, and resolves it once the board answers again", async () => {
      const notifier = fakeNotifier();
      const company = await insertCompany(db.pool, { slug: "acme", name: "Acme" });
      const board = await insertBoard(db.pool, company, { consecutiveFailures: 2, nextPollAt: at(600) });
      await db.pool.query("update board set last_error = 'the feed changed shape: greenhouse: unexpected response shape' where id = $1", [board]);
      const { deps, clock } = setup({ notifier });
      await checkOnce(deps);
      expect(notifier.sent[0]).toMatchObject([{ key: `board:${board}:format`, severity: "critical" }]);

      await db.pool.query("update board set last_error = null, consecutive_failures = 0 where id = $1", [board]);
      clock.now = new Date(NOW.getTime() + 60_000);
      expect(await checkOnce(deps)).toMatchObject({ resolved: [`board:${board}:format`] });
      expect(notifier.sent[1]).toMatchObject([{ kind: "resolved" }]);
    });

    it("tells the owner when so many roles vanished at once that closing is held back", async () => {
      const notifier = fakeNotifier();
      const company = await insertCompany(db.pool, { slug: "acme", name: "Acme" });
      const board = await insertBoard(db.pool, company, { nextPollAt: at(600) });
      for (let i = 0; i < 10; i++) {
        await insertPosting(db.pool, { boardId: board, companyId: company }, { externalId: String(i), ...(i < 5 ? { missedPolls: 1, missedSince: at(-120) } : {}) });
      }
      await checkOnce(setup({ notifier }).deps);
      expect(notifier.sent[0]).toMatchObject([{ key: `board:${board}:mass-drop`, title: "Acme: 5 of 10 roles vanished at once" }]);
    });

    it("sends one message, not forty, when a provider breaks many boards at once", async () => {
      const notifier = fakeNotifier();
      for (let i = 0; i < 40; i++) {
        const company = await insertCompany(db.pool, { slug: `co-${i}`, name: `Company ${i}` });
        const board = await insertBoard(db.pool, company, { token: `t${i}`, consecutiveFailures: 1, nextPollAt: at(600) });
        await db.pool.query("update board set last_error = 'the feed changed shape: x' where id = $1", [board]);
      }
      await checkOnce(setup({ notifier }).deps);
      expect(notifier.sent).toHaveLength(1); // one batch for the notifier, which renders it as a summary
      expect(notifier.sent[0]).toHaveLength(40);
    });
  });
});

describe("runMonitor", () => {
  it("checks at once and then every interval, until told to stop", async () => {
    const notifier = fakeNotifier();
    await overdueBoard(900);
    const { deps } = setup({ notifier });
    const stop = new AbortController();
    const running = runMonitor(deps, stop.signal, 30);
    await waitFor(() => notifier.sent.length === 1, "the first alert to be sent");
    await new Promise((resolve) => setTimeout(resolve, 120)); // several more passes, none of which has anything new to say
    expect(notifier.sent).toHaveLength(1);
    stop.abort();
    await running;
  });

  it("keeps going after a pass fails", async () => {
    const { logger, entries } = createMemoryLogger();
    let calls = 0;
    const flaky = new Proxy(db.pool, {
      get(target, property, receiver) {
        if (property === "query") {
          return (...args: unknown[]) => {
            if (calls++ < 3) return Promise.reject(new Error("connection refused"));
            return (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    await overdueBoard(900);
    const notifier = fakeNotifier();
    const stop = new AbortController();
    const running = runMonitor({ pool: flaky, notifier, log: logger, now: () => NOW }, stop.signal, 20);
    await waitFor(() => notifier.sent.length === 1, "the alert to be sent once the database is back", 5000);
    stop.abort();
    await running;
    expect(entries.some((e) => e.level === "error" && /health check failed/.test(e.msg))).toBe(true);
  });
});

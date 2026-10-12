import { describe, expect, it } from "vitest";
import { reconcileAlerts, markSent } from "../db/alerts.ts";
import { testDatabase } from "../db/testing/database.ts";
import { insertBoard, insertCompany, insertPosting } from "../db/testing/factories.ts";
import { loadOverview } from "./admin-data.ts";

const db = testDatabase();
const NOW = new Date("2026-10-12T12:00:00Z");
const at = (seconds: number): string => new Date(NOW.getTime() + seconds * 1000).toISOString();

const tile = (overview: Awaited<ReturnType<typeof loadOverview>>, label: string) => {
  const found = [...overview.tiles, ...overview.lastTwoDays].find((t) => t.label === label);
  if (!found) throw new Error(`no tile called ${label}`);
  return found;
};

describe("loadOverview", () => {
  it("shows an empty system without alarm", async () => {
    const overview = await loadOverview(db.pool, NOW);
    expect(overview.boards).toEqual([]);
    expect(overview.alerts).toEqual([]);
    expect(overview.tiles.map((t) => t.label)).toEqual(["Worker", "Queue lag", "Polls, last hour", "Boards", "Roles", "Alerts"]);
    expect(overview.tiles.every((t) => !t.attention)).toBe(true);
    expect(tile(overview, "Worker").value).toBe("never polled");
    expect(tile(overview, "Polls, last hour").value).toBe("none");
    expect(overview.lastTwoDays.map((t) => [t.label, t.value, t.attention])).toEqual([
      ["Polls, 48 hours", "none", false],
      ["Queue lag, worst", "no data", false],
      ["Queue lag, typical", "no data", false],
    ]);
  });

  it("reads a working system: roles, changes, polls, and the boards in the order that matters", async () => {
    const acme = await insertCompany(db.pool, { slug: "acme", name: "Acme" });
    const zeta = await insertCompany(db.pool, { slug: "zeta", name: "Zeta" });
    const quiet = await insertCompany(db.pool, { slug: "quiet", name: "Quiet" });
    const okBoard = await insertBoard(db.pool, acme, { token: "acme", nextPollAt: at(120), priority: true, baselinedAt: at(-86400) });
    const failing = await insertBoard(db.pool, zeta, { token: "zeta", nextPollAt: at(300), consecutiveFailures: 2, baselinedAt: at(-86400) });
    await db.pool.query("update board set last_error = 'HTTP 503' where id = $1", [failing]);
    await insertBoard(db.pool, quiet, { token: "quiet", active: false, deactivatedReason: "paused from the admin page" });

    for (let i = 0; i < 4; i++) await insertPosting(db.pool, { boardId: okBoard, companyId: acme }, { externalId: String(i) });
    const posting = await insertPosting(db.pool, { boardId: failing, companyId: zeta }, { externalId: "z" });
    await db.pool.query("insert into posting_event (posting_id, company_id, type, at) values ($1, $2, 'appeared', $3), ($1, $2, 'updated', $4)", [
      posting,
      zeta,
      at(-3600),
      at(-100000), // more than a day ago
    ]);
    for (let i = 0; i < 40; i++) {
      await db.pool.query("insert into poll_run (board_id, started_at, http_status, error) values ($1, $2, $3, $4)", [
        okBoard,
        at(-30 - i),
        i < 2 ? 503 : 304,
        i < 2 ? "HTTP 503" : null,
      ]);
    }

    const overview = await loadOverview(db.pool, NOW);
    expect(overview.boards.map((b) => `${b.name}:${b.state}`)).toEqual(["Zeta:failing", "Acme:ok", "Quiet:paused"]);
    expect(tile(overview, "Roles")).toMatchObject({ value: "5", detail: "1 changes in the last day" });
    expect(tile(overview, "Polls, last hour")).toMatchObject({ value: "95.0% ok", detail: "40 polls, 2 failed; healthy is over 98%", attention: false });
    expect(tile(overview, "Boards")).toMatchObject({ value: "2 on", detail: "1 off · 1 need attention", attention: true });
    expect(tile(overview, "Worker")).toMatchObject({ value: "polled 30 s ago", attention: false });
    expect(tile(overview, "Queue lag")).toMatchObject({ value: "none", attention: false });
  });

  describe("the last 48 hours", () => {
    async function board() {
      const company = await insertCompany(db.pool);
      const id = await insertBoard(db.pool, company, { nextPollAt: at(600) });
      return (secondsAgo: number, lagMs: number | null, error: string | null = null) =>
        db.pool.query("insert into poll_run (board_id, started_at, queue_lag_ms, http_status, error) values ($1, $2, $3, $4, $5)", [
          id,
          at(-secondsAgo),
          lagMs,
          error ? 503 : 304,
          error,
        ]);
    }

    it("sums up the polls and how late they started, leaving out anything older", async () => {
      const run = await board();
      for (let i = 0; i < 98; i++) await run(30 * 3600 + i, 2000); // a day and a half ago, two seconds late
      await run(3600, 40_000);
      await run(7200, 1000, "HTTP 503");
      await run(60 * 3600, 900_000); // outside the window
      const overview = await loadOverview(db.pool, NOW);
      expect(tile(overview, "Polls, 48 hours")).toMatchObject({
        value: "100",
        detail: "99.0% succeeded, 1 failed; healthy is over 98%",
        attention: false,
      });
      expect(tile(overview, "Queue lag, worst")).toMatchObject({ value: "40 s", attention: false });
      expect(tile(overview, "Queue lag, typical")).toMatchObject({
        value: "2 s",
        detail: "median; 95th percentile 2 s; 100.0% of polls started within a minute",
        attention: false,
      });
    });

    it("flags a worst lag of a minute or more, which is what the guide asks to stay under", async () => {
      const run = await board();
      await run(100, 59_000);
      expect(tile(await loadOverview(db.pool, NOW), "Queue lag, worst").attention).toBe(false);
      await run(200, 60_000);
      expect(tile(await loadOverview(db.pool, NOW), "Queue lag, worst")).toMatchObject({ value: "60 s", attention: true });
    });

    it("flags a success rate under 98%, once there are enough polls to mean anything", async () => {
      const run = await board();
      for (let i = 0; i < 19; i++) await run(100 + i, 100);
      await run(200, 100, "HTTP 503"); // 19 of 20: 95%
      expect(tile(await loadOverview(db.pool, NOW), "Polls, 48 hours")).toMatchObject({ value: "20", attention: true });
    });

    it("does not flag a bad rate from a handful of polls", async () => {
      const run = await board();
      await run(100, 100);
      await run(200, 100, "HTTP 503");
      expect(tile(await loadOverview(db.pool, NOW), "Polls, 48 hours")).toMatchObject({ value: "2", attention: false });
    });

    it("says what is missing when polls from before the lag was recorded are all there is", async () => {
      const run = await board();
      await run(100, null);
      const overview = await loadOverview(db.pool, NOW);
      expect(tile(overview, "Polls, 48 hours").value).toBe("1");
      expect(tile(overview, "Queue lag, worst")).toMatchObject({ value: "no data", attention: false });
    });
  });

  it("raises the worker and queue tiles when polling has stopped and boards are overdue", async () => {
    const company = await insertCompany(db.pool);
    const board = await insertBoard(db.pool, company, { nextPollAt: at(-900) });
    await db.pool.query("insert into poll_run (board_id, started_at, http_status) values ($1, $2, 200)", [board, at(-1800)]);
    const overview = await loadOverview(db.pool, NOW);
    expect(tile(overview, "Worker")).toMatchObject({ value: "polled 30 min ago", attention: true });
    expect(tile(overview, "Queue lag")).toMatchObject({ value: "15 min", attention: true });
  });

  it("flags a worker that has never polled once there are boards for it to poll", async () => {
    const company = await insertCompany(db.pool);
    await insertBoard(db.pool, company, { nextPollAt: at(60) });
    expect(tile(await loadOverview(db.pool, NOW), "Worker")).toMatchObject({ value: "never polled", attention: true });
  });

  it("lists open alerts with when they opened and whether the owner was told, and recently resolved ones", async () => {
    const first = await reconcileAlerts(
      db.pool,
      [
        { key: "queue-lag", severity: "critical", title: "Boards are being polled late", detail: "12 min behind" },
        { key: "board:1:gone", severity: "warning", title: "Acme was switched off", detail: "moved" },
      ],
      new Date(NOW.getTime() - 3 * 3600_000),
    );
    await markSent(db.pool, first.notices.filter((n) => n.key === "queue-lag"), new Date(NOW.getTime() - 2 * 3600_000));
    await reconcileAlerts(db.pool, [{ key: "queue-lag", severity: "critical", title: "Boards are being polled late", detail: "12 min behind" }], new Date(NOW.getTime() - 3600_000));

    const overview = await loadOverview(db.pool, NOW);
    expect(overview.alerts).toEqual([
      { key: "queue-lag", severity: "critical", title: "Boards are being polled late", detail: "12 min behind", when: "since 3 h ago", told: "last told 2 h ago" },
    ]);
    expect(overview.resolvedAlerts).toMatchObject([{ key: "board:1:gone", when: "resolved 60 min ago", told: "not told yet" }]);
    expect(tile(overview, "Alerts")).toMatchObject({ value: "1 open", attention: true });
  });
});

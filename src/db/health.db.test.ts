import { describe, expect, it } from "vitest";
import { evaluateHealth } from "../core/health.ts";
import { boardHealth, collectMetrics, lagReport, lastPollAt, pollCounts, queueLagSec } from "./health.ts";
import { testDatabase } from "./testing/database.ts";
import { insertBoard, insertCompany, insertPosting } from "./testing/factories.ts";

const db = testDatabase();
const NOW = new Date("2026-10-12T12:00:00Z");
const at = (seconds: number): string => new Date(NOW.getTime() + seconds * 1000).toISOString();

describe("boardHealth", () => {
  it("lists every board with its company, ordered by company name, and counts open roles and roles on strike", async () => {
    const zeta = await insertCompany(db.pool, { slug: "zeta", name: "Zeta" });
    const acme = await insertCompany(db.pool, { slug: "acme", name: "Acme" });
    const zetaBoard = await insertBoard(db.pool, zeta, { provider: "ashby", token: "zeta" });
    const acmeBoard = await insertBoard(db.pool, acme, { provider: "lever", token: "acme", priority: true, consecutiveFailures: 2 });
    const ids = { boardId: acmeBoard, companyId: acme };
    await insertPosting(db.pool, ids, { externalId: "1" });
    await insertPosting(db.pool, ids, { externalId: "2", missedPolls: 1, missedSince: at(-300) });
    await insertPosting(db.pool, ids, { externalId: "3", missedPolls: 2, missedSince: at(-600) });
    await insertPosting(db.pool, ids, { externalId: "4", status: "closed", closedAt: at(-1000), missedPolls: 2, missedSince: at(-1100) });
    expect(zetaBoard).toBeTruthy();

    const boards = await boardHealth(db.pool);
    expect(boards.map((b) => [b.name, b.provider, b.token])).toEqual([
      ["Acme", "lever", "acme"],
      ["Zeta", "ashby", "zeta"],
    ]);
    expect(boards[0]).toMatchObject({ slug: "acme", priority: true, active: true, consecutiveFailures: 2, openRoles: 3, onStrike: 2 });
    expect(boards[1]).toMatchObject({ openRoles: 0, onStrike: 0, priority: false });
  });

  it("returns real dates and the reason a board was switched off", async () => {
    const company = await insertCompany(db.pool);
    await insertBoard(db.pool, company, { active: false, deactivatedReason: "opt-out requested", nextPollAt: at(100) });
    const [board] = await boardHealth(db.pool);
    expect(board?.nextPollAt).toBeInstanceOf(Date);
    expect(board?.nextPollAt.toISOString()).toBe(at(100));
    expect(board).toMatchObject({ active: false, deactivatedReason: "opt-out requested", lastPolledAt: null, claimedUntil: null });
    expect(board?.deactivatedAt).toBeInstanceOf(Date);
  });

  it("is empty with no boards", async () => {
    expect(await boardHealth(db.pool)).toEqual([]);
  });
});

describe("queueLagSec", () => {
  it("is zero with nothing overdue", async () => {
    expect(await queueLagSec(db.pool, NOW)).toBe(0);
    const company = await insertCompany(db.pool);
    await insertBoard(db.pool, company, { nextPollAt: at(60) });
    expect(await queueLagSec(db.pool, NOW)).toBe(0);
  });

  it("is how overdue the most overdue board is", async () => {
    const company = await insertCompany(db.pool);
    await insertBoard(db.pool, company, { token: "a", nextPollAt: at(-30) });
    await insertBoard(db.pool, company, { token: "b", nextPollAt: at(-400) });
    await insertBoard(db.pool, company, { token: "c", nextPollAt: at(-100) });
    expect(await queueLagSec(db.pool, NOW)).toBe(400);
  });

  it("ignores boards a worker is working on, until their lease has run out", async () => {
    const company = await insertCompany(db.pool);
    const token = "6c8e0a34-6b1e-4f43-9a09-7a8f0f7d2a11";
    await insertBoard(db.pool, company, { token: "held", nextPollAt: at(-900), claimedUntil: at(60), claimToken: token });
    expect(await queueLagSec(db.pool, NOW)).toBe(0);
    await db.pool.query("update board set claimed_until = $1", [at(-10)]);
    expect(await queueLagSec(db.pool, NOW)).toBe(900);
  });

  it("ignores boards that are switched off", async () => {
    const company = await insertCompany(db.pool);
    await insertBoard(db.pool, company, { active: false, nextPollAt: at(-5000) });
    expect(await queueLagSec(db.pool, NOW)).toBe(0);
  });
});

describe("pollCounts and lastPollAt", () => {
  async function seedRuns() {
    const company = await insertCompany(db.pool);
    const board = await insertBoard(db.pool, company);
    const run = (secondsAgo: number, status: number | null, error: string | null) =>
      db.pool.query("insert into poll_run (board_id, started_at, http_status, error) values ($1, $2, $3, $4)", [board, at(-secondsAgo), status, error]);
    await run(30, 200, null);
    await run(120, 304, null);
    await run(600, 503, "HTTP 503");
    await run(3000, 304, null);
    await run(5000, 200, null); // outside the hour
    return board;
  }

  it("counts the polls of the last hour, and the ones that failed; a 304 is not a failure", async () => {
    await seedRuns();
    expect(await pollCounts(db.pool, NOW)).toEqual({ polls: 4, failed: 1 });
  });

  it("can look at another window", async () => {
    await seedRuns();
    expect(await pollCounts(db.pool, NOW, 200)).toEqual({ polls: 2, failed: 0 });
    expect(await pollCounts(db.pool, NOW, 10)).toEqual({ polls: 0, failed: 0 });
  });

  it("finds the time of the last poll, or null", async () => {
    expect(await lastPollAt(db.pool)).toBeNull();
    await seedRuns();
    expect((await lastPollAt(db.pool))?.toISOString()).toBe(at(-30));
  });
});

describe("lagReport", () => {
  let companies = 0;
  async function seedLags(lagsMs: Array<number | null>, secondsAgo = 100) {
    const company = await insertCompany(db.pool, { slug: `lag-${++companies}` });
    const board = await insertBoard(db.pool, company, { token: `lag-${companies}` });
    for (const lag of lagsMs) {
      await db.pool.query("insert into poll_run (board_id, started_at, queue_lag_ms, http_status) values ($1, $2, $3, 200)", [board, at(-secondsAgo), lag]);
    }
  }

  it("says how late polls started: the middle, the 95th percentile, the worst, and how many were within a minute", async () => {
    await seedLags([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((seconds) => seconds * 1000));
    expect(await lagReport(db.pool, NOW, 3600)).toEqual({ polls: 11, medianMs: 5000, p95Ms: 54_500, maxMs: 100_000, withinMinute: 10 / 11 });
  });

  it("counts a poll that started exactly a minute late as late: within a minute means under it", async () => {
    await seedLags([59_999, 60_000]);
    expect((await lagReport(db.pool, NOW, 3600)).withinMinute).toBe(0.5);
  });

  it("leaves out polls from before the lag was recorded, and polls outside the window", async () => {
    await seedLags([2000, null, null]);
    await seedLags([500_000], 7200); // two hours ago
    expect(await lagReport(db.pool, NOW, 3600)).toMatchObject({ polls: 1, maxMs: 2000 });
    expect(await lagReport(db.pool, NOW, 3 * 3600)).toMatchObject({ polls: 2, maxMs: 500_000 });
  });

  it("is empty, not zero, when there is nothing to report", async () => {
    expect(await lagReport(db.pool, NOW, 3600)).toEqual({ polls: 0, medianMs: null, p95Ms: null, maxMs: null, withinMinute: null });
    await seedLags([null]);
    expect((await lagReport(db.pool, NOW, 3600)).polls).toBe(0);
  });
});

describe("collectMetrics", () => {
  it("reads everything the rules need, and the rules can use it as it is", async () => {
    const company = await insertCompany(db.pool, { slug: "acme", name: "Acme" });
    const board = await insertBoard(db.pool, company, { nextPollAt: at(-700) });
    const ids = { boardId: board, companyId: company };
    for (let i = 0; i < 10; i++) {
      await insertPosting(db.pool, ids, { externalId: String(i), ...(i < 6 ? { missedPolls: 1, missedSince: at(-200) } : {}) });
    }
    for (let i = 0; i < 25; i++) {
      await db.pool.query("insert into poll_run (board_id, started_at, http_status, error) values ($1, $2, $3, $4)", [
        board,
        at(-60 - i),
        i < 10 ? 500 : 200,
        i < 10 ? "HTTP 500" : null,
      ]);
    }

    const metrics = await collectMetrics(db.pool, NOW);
    expect(metrics).toMatchObject({ queueLagSec: 700, polls: 25, failedPolls: 10 });
    expect(metrics.boards).toHaveLength(1);

    expect(evaluateHealth(metrics).map((c) => c.key).sort()).toEqual([`board:${board}:mass-drop`, "poll-success", "queue-lag"]);
  });
});

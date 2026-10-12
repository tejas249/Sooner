import { describe, expect, it } from "vitest";
import { GONE_REASON } from "../core/health.ts";
import { PAUSED_REASON, pauseBoard, pollBoardNow, resumeBoard } from "./admin.ts";
import { testDatabase } from "./testing/database.ts";
import { insertBoard, insertCompany, insertPosting } from "./testing/factories.ts";

const db = testDatabase();
const NOW = new Date("2026-10-12T12:00:00Z");
const at = (seconds: number): string => new Date(NOW.getTime() + seconds * 1000).toISOString();

async function board(fields: Parameters<typeof insertBoard>[2] = {}) {
  const company = await insertCompany(db.pool);
  return insertBoard(db.pool, company, fields);
}
const row = async (id: string) =>
  (await db.pool.query("select active, next_poll_at, deactivated_at, deactivated_reason, consecutive_not_found, consecutive_failures, last_error, claim_token from board where id = $1", [id])).rows[0] as {
    active: boolean;
    next_poll_at: Date;
    deactivated_at: Date | null;
    deactivated_reason: string | null;
    consecutive_not_found: number;
    consecutive_failures: number;
    last_error: string | null;
    claim_token: string | null;
  };

describe("pollBoardNow", () => {
  it("makes a board that is not due for hours due now", async () => {
    const id = await board({ nextPollAt: at(3 * 3600) });
    expect(await pollBoardNow(db.pool, id, NOW)).toBe("queued");
    expect((await row(id)).next_poll_at.toISOString()).toBe(NOW.toISOString());
  });

  it("never pushes a board that is already due further into the future", async () => {
    const id = await board({ nextPollAt: at(-900) });
    expect(await pollBoardNow(db.pool, id, NOW)).toBe("queued");
    expect((await row(id)).next_poll_at.toISOString()).toBe(at(-900));
  });

  it("leaves a board that a worker is polling right now alone, apart from making it due", async () => {
    const id = await board({ nextPollAt: at(600), claimedUntil: at(60), claimToken: "6c8e0a34-6b1e-4f43-9a09-7a8f0f7d2a11" });
    expect(await pollBoardNow(db.pool, id, NOW)).toBe("queued");
    expect((await row(id)).claim_token).toBe("6c8e0a34-6b1e-4f43-9a09-7a8f0f7d2a11");
  });

  it("says a switched-off board has nothing to poll, and does not change it", async () => {
    const id = await board({ active: false, nextPollAt: at(3600) });
    expect(await pollBoardNow(db.pool, id, NOW)).toBe("inactive");
    expect((await row(id)).next_poll_at.toISOString()).toBe(at(3600));
  });

  it("says when there is no such board, for any kind of id", async () => {
    expect(await pollBoardNow(db.pool, "999999", NOW)).toBe("missing");
  });

  it("is not fooled by an id that is not a number", async () => {
    await expect(pollBoardNow(db.pool, "1; drop table board", NOW)).rejects.toThrow();
    const { rows } = await db.pool.query("select to_regclass('board') as t");
    expect(rows[0]).toEqual({ t: "board" });
  });
});

describe("pauseBoard", () => {
  it("switches the board off and says why, without touching its roles", async () => {
    const company = await insertCompany(db.pool);
    const id = await insertBoard(db.pool, company);
    const posting = await insertPosting(db.pool, { boardId: id, companyId: company });
    expect(await pauseBoard(db.pool, id, NOW)).toBe(true);
    expect(await row(id)).toMatchObject({ active: false, deactivated_reason: PAUSED_REASON });
    expect((await row(id)).deactivated_at?.toISOString()).toBe(NOW.toISOString());
    const { rows } = await db.pool.query("select status from posting where id = $1", [posting]);
    expect(rows[0]).toEqual({ status: "open" });
  });

  it("does nothing to a board that is already off, so the first reason stays", async () => {
    const id = await board({ active: false, deactivatedReason: GONE_REASON });
    expect(await pauseBoard(db.pool, id, NOW)).toBe(false);
    expect((await row(id)).deactivated_reason).toBe(GONE_REASON);
  });

  it("is a different thing from being gone: the health rules treat it as a choice", async () => {
    const id = await board();
    await pauseBoard(db.pool, id, NOW);
    expect((await row(id)).deactivated_reason).not.toBe(GONE_REASON);
  });
});

describe("resumeBoard", () => {
  it("switches a paused board back on and makes it due", async () => {
    const id = await board({ nextPollAt: at(7200) });
    await pauseBoard(db.pool, id, NOW);
    expect(await resumeBoard(db.pool, id, NOW)).toBe(true);
    const after = await row(id);
    expect(after).toMatchObject({ active: true, deactivated_reason: null, deactivated_at: null });
    expect(after.next_poll_at.toISOString()).toBe(NOW.toISOString());
  });

  it("starts counting 404s again from zero for a board that was switched off for them", async () => {
    const id = await board({ active: false, deactivatedReason: GONE_REASON, consecutiveNotFound: 3, consecutiveFailures: 3, nextPollAt: at(-100) });
    expect(await resumeBoard(db.pool, id, NOW)).toBe(true);
    expect(await row(id)).toMatchObject({ active: true, consecutive_not_found: 0, consecutive_failures: 3 });
  });

  it("does nothing to a board that is already on", async () => {
    const id = await board({ nextPollAt: at(3600) });
    expect(await resumeBoard(db.pool, id, NOW)).toBe(false);
    expect((await row(id)).next_poll_at.toISOString()).toBe(at(3600));
  });

  it("does nothing for a board that does not exist", async () => {
    expect(await resumeBoard(db.pool, "999999", NOW)).toBe(false);
  });
});

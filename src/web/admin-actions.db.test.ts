import { describe, expect, it } from "vitest";
import { testDatabase } from "../db/testing/database.ts";
import { insertBoard, insertCompany } from "../db/testing/factories.ts";
import { OUTCOME_TEXT, isOutcome, performBoardAction } from "./admin-actions.ts";

const db = testDatabase();
const NOW = new Date("2026-10-12T12:00:00Z");

async function board(fields: Parameters<typeof insertBoard>[2] = {}) {
  return insertBoard(db.pool, await insertCompany(db.pool), fields);
}
const active = async (id: string) => ((await db.pool.query("select active from board where id = $1", [id])).rows[0] as { active: boolean }).active;

describe("performBoardAction", () => {
  it("queues a poll for an active board", async () => {
    const id = await board({ nextPollAt: "2026-10-12T18:00:00Z" });
    expect(await performBoardAction(db.pool, "poll", id, NOW)).toBe("queued");
  });

  it("pauses an active board and resumes a paused one", async () => {
    const id = await board();
    expect(await performBoardAction(db.pool, "pause", id, NOW)).toBe("paused");
    expect(await active(id)).toBe(false);
    expect(await performBoardAction(db.pool, "resume", id, NOW)).toBe("resumed");
    expect(await active(id)).toBe(true);
  });

  it("says nothing changed when the page was out of date", async () => {
    const id = await board();
    expect(await performBoardAction(db.pool, "resume", id, NOW)).toBe("unchanged"); // already on
    await performBoardAction(db.pool, "pause", id, NOW);
    expect(await performBoardAction(db.pool, "pause", id, NOW)).toBe("unchanged"); // already off
    expect(await performBoardAction(db.pool, "poll", id, NOW)).toBe("unchanged"); // nothing to poll while off
    expect(await performBoardAction(db.pool, "poll", "424242", NOW)).toBe("unchanged"); // no such board
  });

  it.each([null, undefined, "", "abc", "12 ", "1;drop table board", "-1", "1.5", "０１２", "9".repeat(19), 7, {}, ["1"]])(
    "refuses %j as a board before it gets anywhere near the database",
    async (bad) => {
      const id = await board();
      expect(await performBoardAction(db.pool, "pause", bad, NOW)).toBe("invalid");
      expect(await active(id)).toBe(true);
    },
  );

  it("is a no-op with no database", async () => {
    expect(await performBoardAction(null, "poll", "1", NOW)).toBe("no-database");
    expect(await performBoardAction(null, "poll", "x", NOW)).toBe("invalid");
  });
});

describe("outcomes", () => {
  it("each has a sentence for the page, and unknown values are not outcomes", () => {
    for (const outcome of Object.keys(OUTCOME_TEXT)) expect(isOutcome(outcome)).toBe(true);
    for (const bad of ["", "toString", "__proto__", "<script>", null, 3]) expect(isOutcome(bad)).toBe(false);
  });
});

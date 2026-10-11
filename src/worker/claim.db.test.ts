import { describe, expect, it } from "vitest";
import { testDatabase } from "../db/testing/database.ts";
import { insertBoard, insertCompany } from "../db/testing/factories.ts";
import { claimDueBoards, earliestClaimableAt, releaseLeases } from "./claim.ts";
import { boardRow } from "./testing.ts";

const db = testDatabase();
const NOW = new Date("2026-10-08T12:00:00Z");
const at = (seconds: number): string => new Date(NOW.getTime() + seconds * 1000).toISOString();

async function seedBoards(count: number, fields: Parameters<typeof insertBoard>[2] = {}): Promise<string[]> {
  const companyId = await insertCompany(db.pool, { slug: `company-${Math.random().toString(36).slice(2, 8)}` });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(await insertBoard(db.pool, companyId, { token: `board-${Math.random().toString(36).slice(2, 10)}-${i}`, nextPollAt: at(-60 - i), ...fields }));
  }
  return ids;
}

const claim = (over: Partial<Parameters<typeof claimDueBoards>[1]> = {}) =>
  claimDueBoards(db.pool, { provider: "greenhouse", limit: 10, now: NOW, leaseSec: 120, ...over });

describe("claimDueBoards", () => {
  it("takes the boards that are due and leases them", async () => {
    const [id] = await seedBoards(1);
    const claimed = await claim();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id, provider: "greenhouse", etag: null, pollIntervalSec: 1800, consecutiveFailures: 0, baselinedAt: null });
    expect(claimed[0]?.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    const row = await boardRow(db.pool, id as string);
    expect(row.claimed_until?.toISOString()).toBe(at(120));
    expect(row.claim_token).toBe(claimed[0]?.claimToken);
  });

  it("reports the company, the token and the stored ETag so the poll needs no second query", async () => {
    const companyId = await insertCompany(db.pool, { slug: "stripe", name: "Stripe" });
    await insertBoard(db.pool, companyId, { provider: "lever", token: "stripe-jobs", etag: 'W/"abc"', nextPollAt: at(-1), baselinedAt: at(-3600) });
    const [board] = await claim({ provider: "lever" });
    expect(board).toMatchObject({ companySlug: "stripe", token: "stripe-jobs", etag: 'W/"abc"', baselinedAt: at(-3600) });
  });

  it("skips boards that are not due yet", async () => {
    await seedBoards(1, { nextPollAt: at(1) });
    expect(await claim()).toEqual([]);
    expect(await claim({ now: new Date(NOW.getTime() + 2000) })).toHaveLength(1);
  });

  it("skips inactive boards", async () => {
    await seedBoards(2, { active: false });
    expect(await claim()).toEqual([]);
  });

  it("takes only boards of the provider it was asked for", async () => {
    const companyId = await insertCompany(db.pool);
    await insertBoard(db.pool, companyId, { provider: "greenhouse", token: "a", nextPollAt: at(-10) });
    await insertBoard(db.pool, companyId, { provider: "ashby", token: "b", nextPollAt: at(-10) });
    await insertBoard(db.pool, companyId, { provider: "lever", token: "c", nextPollAt: at(-10) });
    expect((await claim({ provider: "ashby" })).map((b) => b.token)).toEqual(["b"]);
    expect((await claim({ provider: "lever" })).map((b) => b.token)).toEqual(["c"]);
  });

  it("takes the longest-overdue boards first and no more than the limit", async () => {
    const companyId = await insertCompany(db.pool);
    for (const [token, offset] of [["newest", -10], ["oldest", -300], ["middle", -100]] as const) {
      await insertBoard(db.pool, companyId, { token, nextPollAt: at(offset) });
    }
    expect((await claim({ limit: 2 })).map((b) => b.token)).toEqual(["oldest", "middle"]);
    expect((await claim({ limit: 2 })).map((b) => b.token)).toEqual(["newest"]);
  });

  it("asks for nothing when the limit is zero", async () => {
    await seedBoards(1);
    expect(await claim({ limit: 0 })).toEqual([]);
  });

  it("does not hand out a board that is leased, until the lease has run out", async () => {
    await seedBoards(1);
    const first = await claim({ leaseSec: 120 });
    expect(first).toHaveLength(1);
    expect(await claim({ now: new Date(NOW.getTime() + 119_000) })).toEqual([]);
    const second = await claim({ now: new Date(NOW.getTime() + 120_000) });
    expect(second).toHaveLength(1);
    expect(second[0]?.claimToken).not.toBe(first[0]?.claimToken);
  });

  it("never gives the same board to two workers that ask at the same moment", async () => {
    await seedBoards(100);
    const workers = Array.from({ length: 8 }, async () => {
      const mine: string[] = [];
      for (;;) {
        const batch = await claim({ limit: 7 });
        if (batch.length === 0) return mine;
        mine.push(...batch.map((b) => b.id));
      }
    });
    const claimedBy = await Promise.all(workers);
    const all = claimedBy.flat();
    expect(all).toHaveLength(100);
    expect(new Set(all).size).toBe(100);
  });

  it("never claims more than the limit, even when many workers ask together", async () => {
    await seedBoards(60);
    const batches = await Promise.all(Array.from({ length: 12 }, () => claim({ limit: 5 })));
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(5);
    const ids = batches.flat().map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(60);
  });

  it("does not wait for a board another transaction is in the middle of claiming", async () => {
    const [first] = await seedBoards(2);
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from board where id = $1 for update", [first]);
      const startedAt = performance.now();
      const claimed = await claim();
      expect(performance.now() - startedAt).toBeLessThan(1000);
      expect(claimed.map((b) => b.id)).not.toContain(first);
      expect(claimed).toHaveLength(1);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("earliestClaimableAt", () => {
  const all = ["greenhouse", "lever", "ashby"] as const;

  it("is null with no active board", async () => {
    expect(await earliestClaimableAt(db.pool, all)).toBeNull();
    await seedBoards(1, { active: false });
    expect(await earliestClaimableAt(db.pool, all)).toBeNull();
  });

  it("is the earliest due time of the active boards", async () => {
    const companyId = await insertCompany(db.pool);
    await insertBoard(db.pool, companyId, { token: "later", nextPollAt: at(500) });
    await insertBoard(db.pool, companyId, { token: "sooner", nextPollAt: at(30) });
    await insertBoard(db.pool, companyId, { token: "off", nextPollAt: at(1), active: false });
    expect((await earliestClaimableAt(db.pool, all))?.toISOString()).toBe(at(30));
  });

  it("for a leased board is the moment its lease runs out, if that is later than the due time", async () => {
    const companyId = await insertCompany(db.pool);
    await insertBoard(db.pool, companyId, { token: "leased", nextPollAt: at(-100), claimedUntil: at(90), claimToken: "6c8e0a34-6b1e-4f43-9a09-7a8f0f7d2a11" });
    expect((await earliestClaimableAt(db.pool, all))?.toISOString()).toBe(at(90));
  });

  it("looks only at the providers it is asked about, so a full lane does not keep the worker awake", async () => {
    const companyId = await insertCompany(db.pool);
    await insertBoard(db.pool, companyId, { provider: "lever", token: "overdue", nextPollAt: at(-500) });
    await insertBoard(db.pool, companyId, { provider: "greenhouse", token: "later", nextPollAt: at(200) });
    expect((await earliestClaimableAt(db.pool, ["greenhouse", "ashby"]))?.toISOString()).toBe(at(200));
    expect((await earliestClaimableAt(db.pool, ["ashby"]))).toBeNull();
    expect((await earliestClaimableAt(db.pool, []))).toBeNull();
  });
});

describe("releaseLeases", () => {
  it("gives the leases back and leaves the boards due", async () => {
    const [a, b] = await seedBoards(2);
    const claimed = await claim();
    expect(claimed).toHaveLength(2);
    expect(await releaseLeases(db.pool, [claimed[0]?.claimToken as string])).toBe(1);

    const released = await boardRow(db.pool, claimed[0]?.id as string);
    const kept = await boardRow(db.pool, claimed[1]?.id as string);
    expect(released.claimed_until).toBeNull();
    expect(released.claim_token).toBeNull();
    expect(kept.claim_token).toBe(claimed[1]?.claimToken);
    expect(new Set([a, b]).size).toBe(2);
    // The released board can be claimed again at once.
    expect((await claim()).map((x) => x.id)).toEqual([claimed[0]?.id]);
  });

  it("does nothing for no tokens, and ignores tokens that are no longer held", async () => {
    expect(await releaseLeases(db.pool, [])).toBe(0);
    expect(await releaseLeases(db.pool, ["6c8e0a34-6b1e-4f43-9a09-7a8f0f7d2a11"])).toBe(0);
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applySnapshot, confirmPending, emptyBoardState, type TrackedJob } from "../core/changes.ts";
import { job, jobs, many, minutes } from "../core/test-utils.ts";
import type { NormalizedJob } from "../core/types.ts";
import { testDatabase } from "../db/testing/database.ts";
import { insertBoard, insertCompany } from "../db/testing/factories.ts";
import { loadBoardState } from "./postings.ts";
import { pruneOldPollRuns, recordFailure, settlePoll, type PollAnswer, type PollFailure, type SettleOptions } from "./settle.ts";
import { boardRow, eventsOf, leaseBoard, pollRuns } from "./testing.ts";

const db = testDatabase();

let tokenCounter = 0;
async function newBoard(over: { companyId?: string; provider?: string; pollIntervalSec?: number } = {}) {
  const companyId = over.companyId ?? (await insertCompany(db.pool, { slug: `co-${++tokenCounter}` }));
  const boardId = await insertBoard(db.pool, companyId, {
    token: `board-${++tokenCounter}`,
    provider: over.provider ?? "greenhouse",
    pollIntervalSec: over.pollIntervalSec ?? 1800,
  });
  return { companyId, boardId };
}

const snapshot = (list: readonly NormalizedJob[], etag: string | null = 'W/"1"'): PollAnswer => ({ kind: "snapshot", jobs: list, etag });
const unchanged: PollAnswer = { kind: "unchanged" };
const options = (atMinutes: number, over: Partial<SettleOptions> = {}): SettleOptions => ({
  now: minutes(atMinutes),
  followed: true,
  floorSec: 0,
  random: 0.5,
  ...over,
});
const meta = (atMinutes: number) => ({ startedAt: minutes(atMinutes), status: 200, ms: 120, bytes: 2048 });

/** One poll of a board: lease it, then settle the answer at the given minute. */
async function poll(boardId: string, answer: PollAnswer, atMinutes: number, over: Partial<SettleOptions> = {}) {
  const board = await leaseBoard(db.pool, boardId);
  return settlePoll(db.pool, board, answer, meta(atMinutes), options(atMinutes, over));
}

async function fail(boardId: string, atMinutes: number, failure: Partial<PollFailure> = {}, over: { random?: number; floorSec?: number; status?: number } = {}) {
  const board = await leaseBoard(db.pool, boardId);
  return recordFailure(
    db.pool,
    board,
    { kind: "retry", reason: "HTTP 503", retryAfterSec: null, ...failure },
    { ...meta(atMinutes), status: over.status ?? 503 },
    { now: minutes(atMinutes), floorSec: over.floorSec ?? 0, random: over.random ?? 0.5 },
  );
}

async function postings(boardId: string) {
  const { rows } = await db.pool.query<{
    id: string;
    external_id: string;
    title: string;
    title_norm: string;
    status: string;
    baseline: boolean;
    missed_polls: number;
    reopen_count: number;
    repost_of_id: string | null;
    first_seen_at: Date;
    last_seen_at: Date;
    closed_at: Date | null;
  }>(
    `select id, external_id, title, title_norm, status, baseline, missed_polls, reopen_count, repost_of_id,
            first_seen_at, last_seen_at, closed_at
       from posting where board_id = $1 order by external_id`,
    [boardId],
  );
  return rows;
}

const noEvents = { appeared: 0, updated: 0, closed: 0, reopened: 0, reposted: 0 };

describe("the first poll of a board", () => {
  it("records every role as already open and announces nothing", async () => {
    const { boardId } = await newBoard();
    const result = await poll(boardId, snapshot(jobs("a", "b", "c")), 0);

    expect(result).toMatchObject({ outcome: "applied", baseline: true, jobsSeen: 3, openRoles: 3, onStrike: 0 });
    expect(result.counts).toEqual(noEvents);
    const rows = await postings(boardId);
    expect(rows.map((r) => [r.external_id, r.status, r.baseline])).toEqual([
      ["a", "open", true],
      ["b", "open", true],
      ["c", "open", true],
    ]);
    expect(rows[0]).toMatchObject({ title: "Role a", title_norm: "role a" });
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
  });

  it("stores the ETag, the times and a schedule, and gives the lease back", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a"), 'W/"etag-1"'), 0);
    const board = await boardRow(db.pool, boardId);
    expect(board.etag).toBe('W/"etag-1"');
    expect(board.baselined_at?.toISOString()).toBe(minutes(0).toISOString());
    expect(board.last_polled_at?.toISOString()).toBe(minutes(0).toISOString());
    expect(board.last_changed_at?.toISOString()).toBe(minutes(0).toISOString());
    expect(board.consecutive_failures).toBe(0);
    expect(board.claimed_until).toBeNull();
    expect(board.claim_token).toBeNull();
    expect(board.poll_interval_sec).toBe(300); // followed: every five minutes
    expect(board.next_poll_at.toISOString()).toBe(minutes(5).toISOString());
  });

  it("writes one poll_run row", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b")), 0);
    expect(await pollRuns(db.pool, boardId)).toEqual([
      { http_status: 200, duration_ms: 120, bytes: 2048, jobs_seen: 2, new_count: 0, closed_count: 0, error: null, note: null },
    ]);
  });

  it("handles a big board in one go", async () => {
    const { boardId } = await newBoard();
    const startedAt = performance.now();
    const result = await poll(boardId, snapshot(many(900)), 0);
    expect(result.openRoles).toBe(900);
    expect((await postings(boardId)).length).toBe(900);
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });

  it("waits, instead of baselining, when the first answer lists nothing", async () => {
    const { boardId } = await newBoard();
    const held = await poll(boardId, snapshot([], 'W/"empty"'), 0);
    expect(held).toMatchObject({ outcome: "held", jobsSeen: 0 });

    const board = await boardRow(db.pool, boardId);
    expect(board.baselined_at).toBeNull();
    expect(board.etag).toBeNull(); // an answer we did not trust is not remembered, so the next poll is unconditional
    expect(board.claim_token).toBeNull();
    expect(board.next_poll_at.toISOString()).toBe(minutes(5).toISOString());
    expect((await pollRuns(db.pool, boardId))[0]?.note).toMatch(/listed no roles/);

    // When roles do show up, that is the baseline: they were open before we trusted the board, so none of them alerts.
    const result = await poll(boardId, snapshot(jobs("a", "b")), 10);
    expect(result).toMatchObject({ outcome: "applied", baseline: true });
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
  });
});

describe("later polls", () => {
  it("change nothing but the seen-at time when the same list comes back", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b")), 0);
    const before = await postings(boardId);

    const result = await poll(boardId, snapshot(jobs("a", "b")), 10);
    expect(result).toMatchObject({ outcome: "applied", baseline: false });
    expect(result.counts).toEqual(noEvents);
    const after = await postings(boardId);
    expect(after.map((r) => r.last_seen_at.toISOString())).toEqual([minutes(10).toISOString(), minutes(10).toISOString()]);
    expect(after.map((r) => ({ ...r, last_seen_at: null }))).toEqual(before.map((r) => ({ ...r, last_seen_at: null })));
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
    expect((await boardRow(db.pool, boardId)).last_changed_at?.toISOString()).toBe(minutes(0).toISOString());
  });

  it("announce a role that appears, and remember when it was first seen", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a")), 0);
    const result = await poll(boardId, snapshot(jobs("a", "b")), 10);

    expect(result.counts).toEqual({ ...noEvents, appeared: 1 });
    const events = await eventsOf(db.pool, boardId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "appeared", external_id: "b", detail: {} });
    expect(events[0]?.at.toISOString()).toBe(minutes(10).toISOString());
    const b = (await postings(boardId)).find((r) => r.external_id === "b");
    expect(b).toMatchObject({ baseline: false, status: "open" });
    expect(b?.first_seen_at.toISOString()).toBe(minutes(10).toISOString());
    expect((await pollRuns(db.pool, boardId))[1]?.new_count).toBe(1);
    expect((await boardRow(db.pool, boardId)).last_changed_at?.toISOString()).toBe(minutes(10).toISOString());
  });

  it("announce an edit with the fields that changed, and keep the normalised title in step", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot([job("a", { title: "Account Manager - LATAM", location: "Remote" })]), 0);
    await poll(boardId, snapshot([job("a", { title: "Account Manager - Brazil", location: "São Paulo" })]), 10);

    const events = await eventsOf(db.pool, boardId);
    expect(events.map((e) => e.type)).toEqual(["updated"]);
    expect(events[0]?.detail).toEqual({
      changes: [
        { field: "title", from: "Account Manager - LATAM", to: "Account Manager - Brazil" },
        { field: "location", from: "Remote", to: "São Paulo" },
      ],
    });
    const [row] = await postings(boardId);
    expect(row).toMatchObject({ title: "Account Manager - Brazil", title_norm: "account manager brazil" });
    const { rows } = await db.pool.query<{ location_norm: string }>("select location_norm from posting where board_id = $1", [boardId]);
    expect(rows[0]?.location_norm).toBe("sao paulo");
  });

  it("keep a role that is missing once as open, and ask again in two minutes", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b")), 0);
    const result = await poll(boardId, snapshot(jobs("a")), 10);

    expect(result).toMatchObject({ onStrike: 1, suspicious: null });
    expect(result.counts).toEqual(noEvents);
    const b = (await postings(boardId)).find((r) => r.external_id === "b");
    expect(b).toMatchObject({ status: "open", missed_polls: 1 });
    expect((await boardRow(db.pool, boardId)).next_poll_at.toISOString()).toBe(minutes(12).toISOString());
  });

  it("close a role that is missing on two checks at least two minutes apart", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b")), 0);
    await poll(boardId, snapshot(jobs("a")), 10);
    const result = await poll(boardId, snapshot(jobs("a")), 12);

    expect(result.counts).toEqual({ ...noEvents, closed: 1 });
    const b = (await postings(boardId)).find((r) => r.external_id === "b");
    expect(b).toMatchObject({ status: "closed", missed_polls: 2 });
    expect(b?.closed_at?.toISOString()).toBe(minutes(12).toISOString());
    const events = await eventsOf(db.pool, boardId);
    expect(events.at(-1)).toMatchObject({ type: "closed", external_id: "b", detail: { strikes: 2, suspicious: false } });
    expect((await pollRuns(db.pool, boardId))[2]?.closed_count).toBe(1);
  });

  it("do not close a role on two misses that are less than two minutes apart", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b")), 0);
    await poll(boardId, snapshot(jobs("a")), 10);
    const result = await poll(boardId, snapshot(jobs("a")), 11);
    expect(result.counts).toEqual(noEvents);
    expect(result.onStrike).toBe(1);
  });

  it("use a 304 as the second check: the list is unchanged, so the missing role is still missing", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b"), 'W/"before"'), 0);
    await poll(boardId, snapshot(jobs("a"), 'W/"after"'), 10);
    const result = await poll(boardId, unchanged, 12);

    expect(result.counts).toEqual({ ...noEvents, closed: 1 });
    expect((await postings(boardId)).find((r) => r.external_id === "b")?.status).toBe("closed");
    const board = await boardRow(db.pool, boardId);
    expect(board.etag).toBe('W/"after"'); // a 304 keeps the ETag it was answered against
    expect(board.next_poll_at.toISOString()).toBe(minutes(17).toISOString());
  });

  it("treat a 304 with nothing on strike as nothing to do", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b")), 0);
    const before = await postings(boardId);
    const result = await poll(boardId, unchanged, 5);

    expect(result).toMatchObject({ outcome: "applied", jobsSeen: null, onStrike: 0 });
    expect(await postings(boardId)).toEqual(before);
    const runs = await pollRuns(db.pool, boardId);
    expect(runs[1]).toMatchObject({ jobs_seen: null, new_count: 0, closed_count: 0 });
    expect((await boardRow(db.pool, boardId)).last_polled_at?.toISOString()).toBe(minutes(5).toISOString());
  });

  it("do not close a role that comes back before the second check", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b")), 0);
    await poll(boardId, snapshot(jobs("a")), 10);
    await poll(boardId, snapshot(jobs("a", "b")), 12);
    const b = (await postings(boardId)).find((r) => r.external_id === "b");
    expect(b).toMatchObject({ status: "open", missed_polls: 0 });
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
  });

  it("announce a closed role that comes back under the same ID as reopened", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b")), 0);
    await poll(boardId, snapshot(jobs("a")), 10);
    await poll(boardId, snapshot(jobs("a")), 12);
    const result = await poll(boardId, snapshot(jobs("a", "b")), 60);

    expect(result.counts).toEqual({ ...noEvents, reopened: 1 });
    expect((await postings(boardId)).find((r) => r.external_id === "b")).toMatchObject({ status: "open", reopen_count: 1, closed_at: null });
    const reopened = (await eventsOf(db.pool, boardId)).at(-1);
    expect(reopened).toMatchObject({ type: "reopened", detail: { reopenCount: 1, closedAt: minutes(12).toISOString() } });
  });
});

describe("a suspicious drop", () => {
  it("is held back: an empty list does not close anything for twenty minutes, and says why", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(many(5)), 0);
    const first = await poll(boardId, snapshot([]), 10);

    expect(first.counts).toEqual(noEvents);
    expect(first).toMatchObject({ onStrike: 5, suspicious: { open: 5, missing: 5 } });
    expect((await pollRuns(db.pool, boardId))[1]?.note).toMatch(/5 of 5 open roles vanished at once/);
    expect((await boardRow(db.pool, boardId)).next_poll_at.toISOString()).toBe(minutes(20).toISOString()); // ten minutes later

    const second = await poll(boardId, snapshot([]), 20);
    expect(second.counts).toEqual(noEvents);
    const third = await poll(boardId, snapshot([]), 30);
    expect(third.counts).toEqual({ ...noEvents, closed: 5 });
    expect((await eventsOf(db.pool, boardId)).at(-1)?.detail).toMatchObject({ strikes: 3, suspicious: true });
  });

  it("is forgiven when the roles come back", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(many(5)), 0);
    await poll(boardId, snapshot([]), 10);
    await poll(boardId, snapshot(many(5)), 20);
    expect((await postings(boardId)).every((r) => r.status === "open" && r.missed_polls === 0)).toBe(true);
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
  });
});

describe("the schedule", () => {
  it("follows the board's own rhythm when nobody follows it: slower while quiet, faster after a change", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a")), 0, { followed: false });
    expect((await boardRow(db.pool, boardId)).poll_interval_sec).toBe(1800); // the baseline counts as a change

    await poll(boardId, snapshot(jobs("a")), 30, { followed: false });
    expect((await boardRow(db.pool, boardId)).poll_interval_sec).toBe(2700); // quiet: half again as long
    await poll(boardId, snapshot(jobs("a")), 80, { followed: false });
    expect((await boardRow(db.pool, boardId)).poll_interval_sec).toBe(4050);

    await poll(boardId, snapshot(jobs("a", "b")), 160, { followed: false });
    expect((await boardRow(db.pool, boardId)).poll_interval_sec).toBe(2025); // something happened: half as long
  });

  it("never asks a provider sooner than it allows", async () => {
    const { boardId } = await newBoard({ provider: "ashby" });
    await poll(boardId, snapshot(jobs("a")), 0, { followed: true, floorSec: 600 });
    expect((await boardRow(db.pool, boardId)).poll_interval_sec).toBe(600);
  });

  it("spreads boards out with jitter", async () => {
    const early = await newBoard();
    const late = await newBoard();
    await poll(early.boardId, snapshot(jobs("a")), 0, { random: 0 });
    await poll(late.boardId, snapshot(jobs("a")), 0, { random: 0.999999 });
    const a = (await boardRow(db.pool, early.boardId)).next_poll_at.getTime();
    const b = (await boardRow(db.pool, late.boardId)).next_poll_at.getTime();
    expect(a).toBe(minutes(0).getTime() + 270_000);
    expect(b).toBe(minutes(0).getTime() + 330_000);
  });
});

describe("a failed poll", () => {
  it("never changes a role: nothing closes because a request failed", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b", "c")), 0);
    const before = await postings(boardId);

    for (let i = 1; i <= 5; i++) await fail(boardId, i * 10);
    expect(await postings(boardId)).toEqual(before);
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
  });

  it("is counted, remembered with its error, and retried later", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a")), 0);
    const result = await fail(boardId, 10, { reason: "HTTP 503" });

    expect(result).toMatchObject({ outcome: "recorded", failures: 1 });
    const board = await boardRow(db.pool, boardId);
    expect(board).toMatchObject({ consecutive_failures: 1, last_error: "HTTP 503", claim_token: null, claimed_until: null });
    expect(board.next_poll_at.toISOString()).toBe(minutes(15).toISOString()); // not sooner than the normal rhythm
    expect(board.etag).toBe('W/"1"'); // the ETag of the last good answer is kept
    expect((await pollRuns(db.pool, boardId))[1]).toMatchObject({ http_status: 503, jobs_seen: null, error: "HTTP 503" });
  });

  it("waits longer after each failure in a row, and a good poll starts over", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a")), 0);
    const delays: number[] = [];
    for (let i = 1; i <= 4; i++) {
      await fail(boardId, 10);
      delays.push(((await boardRow(db.pool, boardId)).next_poll_at.getTime() - minutes(10).getTime()) / 1000);
    }
    expect(delays).toEqual([300, 300, 480, 960]);

    await poll(boardId, snapshot(jobs("a")), 100);
    expect(await boardRow(db.pool, boardId)).toMatchObject({ consecutive_failures: 0, last_error: null });
  });

  it("obeys Retry-After when it asks for more", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a")), 0);
    await fail(boardId, 10, { kind: "retry", reason: "HTTP 429", retryAfterSec: 3600 });
    expect((await boardRow(db.pool, boardId)).next_poll_at.toISOString()).toBe(minutes(70).toISOString());
  });

  it("keeps what a provider says in an error to one short line of plain text", async () => {
    const { boardId } = await newBoard();
    const noisy = `invalid\u0000\u001b[31m role\nid ${"x".repeat(1000)}`;
    await fail(boardId, 10, { kind: "invalid", reason: noisy });
    const error = (await boardRow(db.pool, boardId)).last_error ?? "";
    expect(error.startsWith("the feed changed shape: invalid")).toBe(true);
    expect([...error].some((ch) => ch.charCodeAt(0) < 32)).toBe(false);
    expect(error.length).toBeLessThanOrEqual(300);
  });
});

describe("a board that keeps answering 404", () => {
  const notFound = { kind: "error", reason: "HTTP 404" } as const;
  const gone = (boardId: string, at: number) => fail(boardId, at, notFound, { status: 404 });

  async function established() {
    const board = await newBoard();
    await poll(board.boardId, snapshot(jobs("a", "b", "c")), 0);
    return board;
  }

  it("is counted, and not asked again for at least half an hour", async () => {
    const { boardId } = await established();
    const result = await gone(boardId, 10);
    expect(result).toMatchObject({ outcome: "recorded", deactivated: false });
    const board = await boardRow(db.pool, boardId);
    expect(board).toMatchObject({ active: true, consecutive_not_found: 1, consecutive_failures: 1 });
    expect(board.next_poll_at.getTime()).toBeGreaterThanOrEqual(minutes(10 + 30).getTime());
  });

  it("is switched off after three in a row, with the reason written down", async () => {
    const { boardId } = await established();
    await gone(boardId, 10);
    await gone(boardId, 50);
    const third = await gone(boardId, 100);

    expect(third).toMatchObject({ outcome: "recorded", deactivated: true });
    const board = await boardRow(db.pool, boardId);
    expect(board).toMatchObject({ active: false, consecutive_not_found: 3, claim_token: null });
    const { rows } = await db.pool.query<{ deactivated_at: Date; deactivated_reason: string }>(
      "select deactivated_at, deactivated_reason from board where id = $1",
      [boardId],
    );
    expect(rows[0]?.deactivated_at.toISOString()).toBe(minutes(100).toISOString());
    expect(rows[0]?.deactivated_reason).toMatch(/answered 404 3 times in a row.*moved to another job-board provider.*roles were left/s);
    expect((await pollRuns(db.pool, boardId)).at(-1)?.note).toMatch(/^switched off: /);
  });

  it("leaves the board's roles exactly as they were: a missing board is not a company that closed everything", async () => {
    const { boardId } = await established();
    const before = await postings(boardId);
    for (const at of [10, 50, 100]) await gone(boardId, at); // the third switches the board off
    expect((await boardRow(db.pool, boardId)).active).toBe(false);
    expect(await postings(boardId)).toEqual(before);
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
  });

  it("is no longer claimed once switched off", async () => {
    const { boardId } = await established();
    for (const at of [10, 50, 100]) await gone(boardId, at);
    await expect(leaseBoard(db.pool, boardId)).rejects.toThrow(/could not be leased/);
  });

  it("starts counting again after any other kind of failure: three in a row means in a row", async () => {
    const { boardId } = await established();
    await gone(boardId, 10);
    await gone(boardId, 50);
    await fail(boardId, 100); // a 503 in between
    expect((await boardRow(db.pool, boardId)).consecutive_not_found).toBe(0);
    await gone(boardId, 150);
    await gone(boardId, 200);
    const board = await boardRow(db.pool, boardId);
    expect(board).toMatchObject({ active: true, consecutive_not_found: 2 });
  });

  it("starts counting again after a good answer", async () => {
    const { boardId } = await established();
    await gone(boardId, 10);
    await gone(boardId, 50);
    await poll(boardId, snapshot(jobs("a", "b", "c")), 100);
    expect((await boardRow(db.pool, boardId)).consecutive_not_found).toBe(0);
  });

  it("is not mistaken for other errors: a 403 or a rejected redirect is just a failure", async () => {
    const { boardId } = await established();
    for (const at of [10, 20, 30, 40]) await fail(boardId, at, { kind: "error", reason: "HTTP 403" }, { status: 403 });
    expect(await boardRow(db.pool, boardId)).toMatchObject({ active: true, consecutive_not_found: 0, consecutive_failures: 4 });
  });

  it("is not mistaken for a 404 that arrives as something retryable", async () => {
    const { boardId } = await established();
    await fail(boardId, 10, { kind: "retry", reason: "HTTP 404" }, { status: 404 });
    expect((await boardRow(db.pool, boardId)).consecutive_not_found).toBe(0);
  });
});

describe("repost detection", () => {
  /** A company whose role "b" opened, closed on day 1, and may now come back under a new ID. */
  async function closedRole(titleOverride?: { title: string; location?: string }) {
    const { companyId, boardId } = await newBoard();
    const original = titleOverride ? [job("a"), job("b", titleOverride)] : jobs("a", "b");
    await poll(boardId, snapshot(original), 0);
    await poll(boardId, snapshot([original[0] as NormalizedJob]), 10);
    await poll(boardId, snapshot([original[0] as NormalizedJob]), 12);
    expect((await postings(boardId)).find((r) => r.external_id === "b")?.status).toBe("closed");
    return { companyId, boardId, original };
  }

  it("calls a role that closed and came back under a new ID a repost, with the evidence", async () => {
    const { boardId, original } = await closedRole();
    const result = await poll(boardId, snapshot([original[0] as NormalizedJob, job("c", { title: "Role b" })]), 10 * 24 * 60);

    expect(result.counts).toEqual({ ...noEvents, reposted: 1 });
    const rows = await postings(boardId);
    const origin = rows.find((r) => r.external_id === "b");
    const copy = rows.find((r) => r.external_id === "c");
    expect(copy?.repost_of_id).toBe(origin?.id);
    const event = (await eventsOf(db.pool, boardId)).at(-1);
    expect(event).toMatchObject({ type: "reposted", external_id: "c" });
    expect(event?.detail).toEqual({ repostOf: origin?.id, closedAt: minutes(12).toISOString(), daysSinceClosed: 10 });
    expect((await pollRuns(db.pool, boardId)).at(-1)?.new_count).toBe(1); // a repost still counts as a new listing
  });

  it("matches a very similar title, not only an identical one", async () => {
    const { boardId, original } = await closedRole({ title: "Senior Software Engineer, Payments Platform" });
    await poll(boardId, snapshot([original[0] as NormalizedJob, job("c", { title: "Senior Software Engineer, Payments Platform II" })]), 24 * 60);
    expect((await eventsOf(db.pool, boardId)).at(-1)?.type).toBe("reposted");
  });

  it("does not call a different role a repost", async () => {
    const { boardId, original } = await closedRole();
    await poll(boardId, snapshot([original[0] as NormalizedJob, job("c", { title: "Head of Gardening" })]), 24 * 60);
    expect((await eventsOf(db.pool, boardId)).at(-1)?.type).toBe("appeared");
  });

  it("does not call the same title in another place a repost", async () => {
    const { boardId, original } = await closedRole();
    await poll(boardId, snapshot([original[0] as NormalizedJob, job("c", { title: "Role b", location: "Lisbon" })]), 24 * 60);
    expect((await eventsOf(db.pool, boardId)).at(-1)?.type).toBe("appeared");
  });

  it("does not call a role a repost when one like it is open right now: five identical openings are not a repost machine", async () => {
    const { companyId, boardId } = await closedRole();
    // A second board of the same company has an open role with the same fingerprint as the closed "b".
    const other = await insertBoard(db.pool, companyId, { token: "other-board" });
    await poll(other, snapshot([job("x", { title: "Role b" })]), 5 * 24 * 60);
    await poll(other, snapshot([job("x", { title: "Role b" }), job("y", { title: "Role b" })]), 6 * 24 * 60);
    expect((await eventsOf(db.pool, other)).at(-1)?.type).toBe("appeared");
    expect(boardId).not.toBe(other);
  });

  it("does not call it a repost after sixty days", async () => {
    const { boardId, original } = await closedRole();
    await poll(boardId, snapshot([original[0] as NormalizedJob, job("c", { title: "Role b" })]), 61 * 24 * 60);
    expect((await eventsOf(db.pool, boardId)).at(-1)?.type).toBe("appeared");
  });

  it("does not count a role from another company", async () => {
    const { original } = await closedRole();
    const stranger = await newBoard();
    await poll(stranger.boardId, snapshot([job("z0")]), 24 * 60);
    await poll(stranger.boardId, snapshot([job("z0"), job("z1", { title: "Role b" })]), 24 * 60 + 10);
    expect((await eventsOf(db.pool, stranger.boardId)).at(-1)?.type).toBe("appeared");
    expect(original).toHaveLength(2);
  });

  it("lets a closed role be the origin of only one repost, even when two identical roles appear together", async () => {
    const { boardId, original } = await closedRole();
    const result = await poll(
      boardId,
      snapshot([original[0] as NormalizedJob, job("c", { title: "Role b" }), job("d", { title: "Role b" })]),
      24 * 60,
    );
    expect(result.counts).toEqual({ ...noEvents, appeared: 1, reposted: 1 });
    const types = Object.fromEntries((await eventsOf(db.pool, boardId)).slice(-2).map((e) => [e.external_id, e.type]));
    expect(types).toEqual({ c: "reposted", d: "appeared" });
  });

  it("never treats the baseline as a repost", async () => {
    const { boardId } = await newBoard();
    const result = await poll(boardId, snapshot(jobs("a", "b")), 0);
    expect(result.counts).toEqual(noEvents);
  });
});

describe("a poll that cannot finish", () => {
  it("applies nothing when it fails after the diff and before the commit, and the lease stays intact", async () => {
    const { boardId } = await newBoard();
    const board = await leaseBoard(db.pool, boardId);
    const leased = await boardRow(db.pool, boardId);

    await expect(
      settlePoll(db.pool, board, snapshot(jobs("a", "b", "c")), meta(0), {
        ...options(0),
        beforeCommit: () => Promise.reject(new Error("the process was killed here")),
      }),
    ).rejects.toThrow(/killed here/);

    expect(await postings(boardId)).toEqual([]);
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
    expect(await pollRuns(db.pool, boardId)).toEqual([]);
    const after = await boardRow(db.pool, boardId);
    expect(after).toEqual(leased); // ETag, baseline, schedule and the lease are all as they were
    expect(after.claim_token).toBe(board.claimToken);
    expect(after.baselined_at).toBeNull();
  });

  it("applies nothing from the second half either: a failed update of an established board rolls back whole", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a", "b")), 0);
    const before = await postings(boardId);
    const board = await leaseBoard(db.pool, boardId);

    await expect(
      settlePoll(db.pool, board, snapshot([job("a", { title: "Edited" }), job("c")]), meta(10), {
        ...options(10),
        beforeCommit: () => Promise.reject(new Error("boom")),
      }),
    ).rejects.toThrow(/boom/);

    expect(await postings(boardId)).toEqual(before);
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
    expect(await pollRuns(db.pool, boardId)).toHaveLength(1);
  });

  it("gives the same result when the poll is simply run again after a failure", async () => {
    const first = await newBoard();
    const second = await newBoard();
    const answer = snapshot(jobs("a", "b", "c"));

    const board = await leaseBoard(db.pool, first.boardId);
    await expect(
      settlePoll(db.pool, board, answer, meta(0), { ...options(0), beforeCommit: () => Promise.reject(new Error("boom")) }),
    ).rejects.toThrow();
    // The crashed worker's lease runs out, and the board is polled again.
    await db.pool.query("update board set claimed_until = null, claim_token = null where id = $1", [first.boardId]);
    await poll(first.boardId, answer, 0);
    await poll(second.boardId, answer, 0);

    // The database IDs differ between the two boards; everything else must match.
    const strip = (rows: Awaited<ReturnType<typeof postings>>) =>
      rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id")));
    expect(strip(await postings(first.boardId))).toEqual(strip(await postings(second.boardId)));
  });

  it("writes nothing when another worker has taken the board over", async () => {
    const { boardId } = await newBoard();
    await poll(boardId, snapshot(jobs("a")), 0);
    const stale = await leaseBoard(db.pool, boardId);
    // The lease ran out and a second worker claimed the board: the token on the board is no longer ours.
    await db.pool.query("update board set claim_token = gen_random_uuid() where id = $1", [boardId]);
    const taken = await boardRow(db.pool, boardId);

    const settled = await settlePoll(db.pool, stale, snapshot(jobs("a", "b", "c")), meta(10), options(10));
    expect(settled.outcome).toBe("lease-lost");
    const failed = await recordFailure(
      db.pool,
      stale,
      { kind: "retry", reason: "HTTP 500", retryAfterSec: null },
      meta(10),
      { now: minutes(10), floorSec: 0, random: 0.5 },
    );
    expect(failed.outcome).toBe("lease-lost");

    expect((await postings(boardId)).map((r) => r.external_id)).toEqual(["a"]);
    expect(await pollRuns(db.pool, boardId)).toHaveLength(1);
    expect(await boardRow(db.pool, boardId)).toEqual(taken); // the new holder's lease is untouched
  });
});

describe("pruneOldPollRuns", () => {
  it("deletes poll runs older than a week and keeps the rest", async () => {
    const { boardId } = await newBoard();
    const now = minutes(0);
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    for (const days of [30, 8, 7.5, 6, 1, 0]) {
      await db.pool.query("insert into poll_run (board_id, started_at, http_status) values ($1, $2, 200)", [boardId, ago(days)]);
    }
    expect(await pruneOldPollRuns(db.pool, now)).toBe(3);
    const { rows } = await db.pool.query<{ n: number }>("select count(*)::int as n from poll_run");
    expect(rows[0]?.n).toBe(3);
    expect(await pruneOldPollRuns(db.pool, now)).toBe(0);
  });
});

describe("the database path, for any sequence of polls", () => {
  const IDS = ["a", "b", "c", "d", "e", "f"] as const;
  const arbSnapshot: fc.Arbitrary<NormalizedJob[]> = fc
    .dictionary(
      fc.constantFrom(...IDS),
      fc.record({ title: fc.constantFrom("Engineer", "Designer", "Manager"), location: fc.constantFrom("Remote", "Berlin", null) }),
    )
    .map((byId) => Object.entries(byId).map(([id, fields]) => job(id, fields)));
  const arbSteps = fc.array(
    fc.record({
      snapshot: arbSnapshot,
      gap: fc.integer({ min: 0, max: 30 }),
      kind: fc.constantFrom("snapshot", "snapshot", "snapshot", "unchanged", "failure"),
    }),
    { maxLength: 7 },
  );

  const byId = (rows: readonly TrackedJob[]) => [...rows].sort((a, b) => (a.externalId < b.externalId ? -1 : 1));

  it("leaves exactly the rows the pure reducer says, and breaks no rule of the schema", async () => {
    await fc.assert(
      fc.asyncProperty(arbSteps, async (steps) => {
        const { boardId } = await newBoard();
        let model = emptyBoardState();
        let clock = 0;
        let expectedEvents = 0;

        for (const step of steps) {
          clock += step.gap;
          if (step.kind === "failure") {
            await fail(boardId, clock);
            continue;
          }
          if (step.kind === "unchanged" && model.baselinedAt !== null) {
            const result = confirmPending(model, minutes(clock));
            model = result.state;
            expectedEvents += result.events.length;
            await poll(boardId, unchanged, clock);
          } else {
            const held = model.baselinedAt === null && step.snapshot.length === 0;
            if (!held) {
              const result = applySnapshot(model, step.snapshot, minutes(clock));
              model = result.state;
              expectedEvents += result.events.length;
            }
            await poll(boardId, snapshot(step.snapshot), clock);
          }

          const board = await boardRow(db.pool, boardId);
          const stored = (await loadBoardState(db.pool, boardId, board.baselined_at?.toISOString() ?? null)).state;
          expect(stored.baselinedAt).toBe(model.baselinedAt);
          expect(byId(stored.jobs)).toEqual(byId(model.jobs));
          expect(board.claim_token).toBeNull();
        }
        expect(await eventsOf(db.pool, boardId)).toHaveLength(expectedEvents);
      }),
      { numRuns: 30 },
    );
  }, 180_000);
});

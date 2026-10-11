import { describe, expect, it } from "vitest";
import { adapters } from "../core/adapters/index.ts";
import { job, jobs, many, minutes } from "../core/test-utils.ts";
import type { NormalizedJob } from "../core/types.ts";
import { testDatabase } from "../db/testing/database.ts";
import { insertBoard, insertCompany } from "../db/testing/factories.ts";
import { createMemoryLogger } from "./log.ts";
import { pollClaimedBoard, type PollTaskDeps } from "./poll-task.ts";
import {
  ashbyBody,
  boardRow,
  errorAnswer,
  eventsOf,
  leaseBoard,
  notModifiedAnswer,
  okAnswer,
  pollRuns,
  retryAnswer,
  scriptedFetcher,
  type ScriptedFetcher,
} from "./testing.ts";

const db = testDatabase();

let counter = 0;
async function newBoard(over: { etag?: string | null } = {}) {
  const companyId = await insertCompany(db.pool, { slug: `co-${++counter}` });
  const token = `board-${++counter}`;
  const boardId = await insertBoard(db.pool, companyId, { provider: "ashby", token, etag: over.etag ?? null });
  return { companyId, boardId, token, url: adapters.ashby.url(token) };
}

/** Leases the board and polls it once, as the loop would. */
async function runTask(
  boardId: string,
  fetcher: ScriptedFetcher,
  atMinutes: number,
  over: Partial<PollTaskDeps> = {},
) {
  const { logger, entries } = createMemoryLogger();
  const board = await leaseBoard(db.pool, boardId);
  const outcome = await pollClaimedBoard(
    {
      pool: db.pool,
      fetcher,
      now: () => minutes(atMinutes),
      random: () => 0.5,
      log: logger,
      followed: true,
      signal: new AbortController().signal,
      ...over,
    },
    board,
  );
  return { outcome, entries, board };
}

const lines = (entries: ReturnType<typeof createMemoryLogger>["entries"], msg: string) => entries.filter((e) => e.msg === msg);

const answering = (roles: readonly NormalizedJob[], etag = 'W/"1"') => scriptedFetcher(() => okAnswer(ashbyBody(roles), etag));

describe("a poll that gets a good answer", () => {
  it("fetches the board's own feed with its stored ETag and applies the roles", async () => {
    const { boardId, url } = await newBoard({ etag: 'W/"old"' });
    const fetcher = answering(jobs("a", "b"), 'W/"new"');
    const { outcome } = await runTask(boardId, fetcher, 0);

    expect(outcome).toBe("applied");
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]?.url).toBe(url);
    expect(fetcher.calls[0]?.options).toMatchObject({ etag: 'W/"old"', timeoutMs: adapters.ashby.timeoutMs });
    const board = await boardRow(db.pool, boardId);
    expect(board).toMatchObject({ etag: 'W/"new"', claim_token: null, consecutive_failures: 0 });
    const { rows } = await db.pool.query<{ n: number }>("select count(*)::int as n from posting where board_id = $1", [boardId]);
    expect(rows[0]?.n).toBe(2);
  });

  it("logs one line per poll with the numbers, and no role titles", async () => {
    const { boardId } = await newBoard();
    const { entries } = await runTask(boardId, answering(jobs("a", "b", "c")), 0);
    const [line] = lines(entries, "poll");
    expect(line).toMatchObject({
      level: "info",
      provider: "ashby",
      status: 200,
      ms: 40,
      baseline: true,
      changed: true,
      jobs_seen: 3,
      open: 3,
      appeared: 0,
      closed: 0,
      on_strike: 0,
      next_poll_in_s: 300,
    });
    expect(JSON.stringify(entries)).not.toContain("Role a");
  });

  it("treats a 304 as a poll that found nothing new", async () => {
    const { boardId } = await newBoard();
    await runTask(boardId, answering(jobs("a")), 0);
    const { outcome } = await runTask(boardId, scriptedFetcher(() => notModifiedAnswer()), 5);
    expect(outcome).toBe("applied");
    expect((await pollRuns(db.pool, boardId)).map((r) => r.http_status)).toEqual([200, 304]);
    expect((await boardRow(db.pool, boardId)).etag).toBe('W/"1"');
  });

  it("sends the ETag it stored last time on the next request", async () => {
    const { boardId } = await newBoard();
    await runTask(boardId, answering(jobs("a"), 'W/"first"'), 0);
    const second = scriptedFetcher(() => notModifiedAnswer());
    await runTask(boardId, second, 5);
    expect(second.calls[0]?.options.etag).toBe('W/"first"');
  });

  it("warns when so many roles vanish at once that closing is held back", async () => {
    const { boardId } = await newBoard();
    await runTask(boardId, answering(many(10)), 0);
    const { entries } = await runTask(boardId, answering(many(5)), 10);
    const [warning] = lines(entries, "many roles vanished at once; closing is held back for three checks over twenty minutes");
    expect(warning).toMatchObject({ level: "warn", open: 10, missing: 5 });
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
  });

  it("warns when the first answer lists nothing", async () => {
    const { boardId } = await newBoard();
    const { outcome, entries } = await runTask(boardId, answering([]), 0);
    expect(outcome).toBe("held");
    expect(lines(entries, "the first poll listed no roles; the board is not baselined yet")).toHaveLength(1);
  });
});

describe("a poll that does not get a good answer", () => {
  async function establishedBoard() {
    const board = await newBoard();
    await runTask(board.boardId, answering(jobs("a", "b", "c")), 0);
    return board;
  }

  async function expectNothingChanged(boardId: string, failuresExpected: number) {
    const { rows } = await db.pool.query<{ external_id: string; status: string; missed_polls: number }>(
      "select external_id, status, missed_polls from posting where board_id = $1 order by external_id",
      [boardId],
    );
    expect(rows).toEqual([
      { external_id: "a", status: "open", missed_polls: 0 },
      { external_id: "b", status: "open", missed_polls: 0 },
      { external_id: "c", status: "open", missed_polls: 0 },
    ]);
    expect(await eventsOf(db.pool, boardId)).toEqual([]);
    const board = await boardRow(db.pool, boardId);
    expect(board).toMatchObject({ consecutive_failures: failuresExpected, claim_token: null, etag: 'W/"1"' });
  }

  it("records a 429 with the wait the provider asked for, and changes no role", async () => {
    const { boardId } = await establishedBoard();
    const { outcome, entries } = await runTask(boardId, scriptedFetcher(() => retryAnswer("HTTP 429", 1800, 429)), 10);
    expect(outcome).toBe("failed");
    await expectNothingChanged(boardId, 1);
    expect((await boardRow(db.pool, boardId)).next_poll_at.toISOString()).toBe(minutes(40).toISOString());
    expect(lines(entries, "poll failed")[0]).toMatchObject({ level: "warn", kind: "retry", status: 429, reason: "HTTP 429", failures: 1, next_poll_in_s: 1800 });
  });

  it("records a 5xx", async () => {
    const { boardId } = await establishedBoard();
    expect((await runTask(boardId, scriptedFetcher(() => retryAnswer("HTTP 503")), 10)).outcome).toBe("failed");
    await expectNothingChanged(boardId, 1);
  });

  it("records a board that is gone (404) without closing its roles", async () => {
    const { boardId } = await establishedBoard();
    for (let i = 1; i <= 4; i++) await runTask(boardId, scriptedFetcher(() => errorAnswer("HTTP 404", 404)), 10 * i);
    await expectNothingChanged(boardId, 4);
    expect((await boardRow(db.pool, boardId)).last_error).toBe("HTTP 404");
  });

  it("records a timeout or a dead connection", async () => {
    const { boardId } = await establishedBoard();
    await runTask(boardId, scriptedFetcher(() => ({ kind: "retry", status: null, ms: 30_000, bytes: 0, reason: "timeout", retryAfterSec: null })), 10);
    await expectNothingChanged(boardId, 1);
    expect((await pollRuns(db.pool, boardId)).at(-1)).toMatchObject({ http_status: null, duration_ms: 30_000, error: "timeout" });
  });

  it("treats an answer that is not JSON as a change of format: nothing changes and the log says error", async () => {
    const { boardId } = await establishedBoard();
    const { outcome, entries } = await runTask(boardId, scriptedFetcher(() => okAnswer("<html>maintenance</html>")), 10);
    expect(outcome).toBe("failed");
    await expectNothingChanged(boardId, 1);
    expect((await boardRow(db.pool, boardId)).last_error).toMatch(/^the feed changed shape: ashby: the answer is not JSON/);
    expect(lines(entries, "poll failed")[0]).toMatchObject({ level: "error", kind: "invalid" });
  });

  it("treats an answer of the wrong shape as a change of format, and never as every role closing", async () => {
    const { boardId } = await establishedBoard();
    // Valid JSON, empty object: no "jobs" at all. Reading this as "no roles" would close everything.
    const { outcome } = await runTask(boardId, scriptedFetcher(() => okAnswer("{}")), 10);
    expect(outcome).toBe("failed");
    await expectNothingChanged(boardId, 1);
  });

  it("treats a role without an ID as a change of format", async () => {
    const { boardId } = await establishedBoard();
    const broken = JSON.stringify({ jobs: [{ title: "Engineer", jobUrl: "https://x.example/1", isListed: true }] });
    expect((await runTask(boardId, scriptedFetcher(() => okAnswer(broken)), 10)).outcome).toBe("failed");
    await expectNothingChanged(boardId, 1);
  });

  it("survives a fetcher that throws, which would be a bug on our side", async () => {
    const { boardId } = await establishedBoard();
    const { outcome, entries } = await runTask(
      boardId,
      scriptedFetcher(() => {
        throw new Error("undefined is not a function");
      }),
      10,
    );
    expect(outcome).toBe("failed");
    await expectNothingChanged(boardId, 1);
    expect(lines(entries, "fetching crashed")[0]).toMatchObject({ level: "error" });
    expect((await boardRow(db.pool, boardId)).last_error).toMatch(/unexpected error: undefined is not a function/);
  });

  it("backs off and records the failure when the database write fails, instead of retrying hot", async () => {
    const { boardId } = await establishedBoard();
    const { outcome, entries } = await runTask(boardId, answering(jobs("a", "b", "c", "d")), 10, {
      beforeCommit: () => Promise.reject(new Error("connection terminated")),
    });
    expect(outcome).toBe("failed");
    await expectNothingChanged(boardId, 1);
    expect(lines(entries, "applying the poll failed; nothing was changed")).toHaveLength(1);
    expect((await boardRow(db.pool, boardId)).last_error).toMatch(/database error: connection terminated/);
  });
});

describe("a poll that is cut short", () => {
  it("gives the lease back without counting a failure when the worker is shutting down", async () => {
    const { boardId } = await newBoard();
    const stop = new AbortController();
    const fetcher = scriptedFetcher(() => {
      stop.abort();
      return retryAnswer("aborted", null, null);
    });
    const { outcome, board } = await runTask(boardId, fetcher, 0, { signal: stop.signal });

    expect(outcome).toBe("aborted");
    const after = await boardRow(db.pool, boardId);
    expect(after).toMatchObject({ claim_token: null, claimed_until: null, consecutive_failures: 0, last_error: null });
    expect(await pollRuns(db.pool, boardId)).toEqual([]);
    expect(board.claimToken).toBeTruthy();
  });

  it("passes the shutdown signal to the fetcher so the request itself can be cancelled", async () => {
    const { boardId } = await newBoard();
    const stop = new AbortController();
    const fetcher = answering(jobs("a"));
    await runTask(boardId, fetcher, 0, { signal: stop.signal });
    expect(fetcher.calls[0]?.options.signal).toBe(stop.signal);
  });

  it("writes nothing when the board has been taken over by another worker", async () => {
    const { boardId } = await newBoard();
    const board = await leaseBoard(db.pool, boardId);
    await db.pool.query("update board set claim_token = gen_random_uuid() where id = $1", [boardId]);
    const { logger, entries } = createMemoryLogger();
    const outcome = await pollClaimedBoard(
      { pool: db.pool, fetcher: answering(jobs("a")), now: () => minutes(0), random: () => 0.5, log: logger, followed: true, signal: new AbortController().signal },
      board,
    );
    expect(outcome).toBe("lease-lost");
    expect(lines(entries, "the lease was lost to another worker; nothing was written")).toHaveLength(1);
    expect(await pollRuns(db.pool, boardId)).toEqual([]);
  });
});

describe("what a provider sends is untrusted", () => {
  it("cannot get a control character into the database", async () => {
    const { boardId } = await newBoard();
    const NUL = String.fromCharCode(0);
    const body = ashbyBody([job("a", { title: `Engineer${NUL}II`, location: `Remote${NUL}` })]);
    expect((await runTask(boardId, scriptedFetcher(() => okAnswer(body)), 0)).outcome).toBe("applied");
    const { rows } = await db.pool.query<{ title: string; location: string }>("select title, location from posting where board_id = $1", [boardId]);
    expect(rows[0]).toEqual({ title: "Engineer II", location: "Remote" });
  });

  it("cannot make one poisoned role stop its board: a NUL in an ID fails the poll cleanly instead of the transaction", async () => {
    const { boardId } = await newBoard();
    const NUL = String.fromCharCode(0);
    const body = ashbyBody([job(`id${NUL}1`)]);
    const { outcome } = await runTask(boardId, scriptedFetcher(() => okAnswer(body)), 0);
    expect(outcome).toBe("failed");
    expect((await boardRow(db.pool, boardId)).last_error).toMatch(/^the feed changed shape/);
  });
});

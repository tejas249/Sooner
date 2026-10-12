import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { failureDelaySec } from "../core/schedule.ts";
import { PROVIDERS, type NormalizedJob, type Provider } from "../core/types.ts";
import { testDatabase } from "../db/testing/database.ts";
import { insertBoard, insertCompany, type BoardFields } from "../db/testing/factories.ts";
import { createFetcher } from "./fetcher.ts";
import { HostGate } from "./gate.ts";
import { createMemoryLogger } from "./log.ts";
import { defaultLoopSettings, runWorker } from "./loop.ts";
import { mockRoles, startMockProviders, type Behavior, type MockProviders } from "./mock-boards.ts";
import { boardRow, eventsOf, pollRuns, waitFor } from "./testing.ts";

/**
 * The worker as a whole, against mock job boards on this machine: the real loop, the real fetcher and politeness gate, the
 * real adapters and a real Postgres. What is under test here is how the pieces behave together over HTTP.
 */

const db = testDatabase();
let mock: MockProviders;

beforeAll(async () => {
  mock = await startMockProviders({ timeoutMs: 400 });
});
afterAll(async () => {
  await mock.stop();
});

const T = new Date("2026-10-12T12:00:00Z");
const minutesAfter = (m: number): Date => new Date(T.getTime() + m * 60_000);
const PAST = new Date(T.getTime() - 3_600_000).toISOString();

let counter = 0;
async function addBoard(provider: Provider, roles: NormalizedJob[], over: BoardFields = {}): Promise<{ id: string; token: string }> {
  const token = `${provider}-${++counter}`;
  mock.board(provider, token).set(roles);
  const companyId = await insertCompany(db.pool, { slug: `co-${counter}` });
  const id = await insertBoard(db.pool, companyId, { provider, token, nextPollAt: PAST, priority: true, ...over });
  return { id, token };
}

const makeDue = (ids: string[]) => db.pool.query("update board set next_poll_at = $1 where id = any($2::bigint[])", [PAST, ids]);

/** The real gate, which also notes the moment it lets each request through. */
class RecordingGate extends HostGate {
  readonly released: Array<{ host: string; at: number }> = [];
  override async acquire(host: string): Promise<() => void> {
    const release = await super.acquire(host);
    this.released.push({ host, at: performance.now() });
    return release;
  }
}

/** The shortest time between two of these moments, or Infinity for fewer than two. */
function shortestGap(moments: number[]): number {
  const sorted = [...moments].sort((a, b) => a - b);
  let shortest = Infinity;
  for (let i = 1; i < sorted.length; i++) shortest = Math.min(shortest, (sorted[i] as number) - (sorted[i - 1] as number));
  return shortest;
}

/** The gate counts in whole milliseconds and these moments are not, so the second can come a millisecond or two short. */
const CLOCK_ROUNDING_MS = 2;

interface RunOptions {
  /** Requests to one host start at least this far apart: 1000 is the real rule, 0 skips the wait. */
  gapMs?: number;
  /** A gate to use instead of a plain one with `gapMs`. */
  gate?: HostGate;
  now?: () => Date;
}

/** Polls everything that is due, once, the way the worker does. */
async function pollDue(options: RunOptions = {}) {
  const { logger, entries } = createMemoryLogger();
  const fetcher = createFetcher({
    userAgent: "Sooner/0.1 (+local development run, no public contact yet)",
    gate: options.gate ?? new HostGate({ gapMs: options.gapMs ?? 0 }),
    now: options.now ?? (() => T), // a Retry-After given as a date is turned into seconds on this clock
  });
  const summary = await runWorker(
    { pool: db.pool, fetcher, now: options.now ?? (() => T), random: () => 0.5, log: logger, adapters: mock.adapters },
    defaultLoopSettings({ idleMaxMs: 30, minWaitMs: 5, followed: true, lanes: { greenhouse: 4, lever: 3, ashby: 4 } }),
    new AbortController().signal,
    { once: true },
  );
  return { summary, entries };
}

const openRoles = async (boardId: string) => {
  const { rows } = await db.pool.query<{ external_id: string; status: string; missed_polls: number }>(
    "select external_id, status, missed_polls from posting where board_id = $1 order by external_id",
    [boardId],
  );
  return rows;
};

describe("politeness", () => {
  it("no host receives more than one request per second, and no more than two at once, however many boards are due", async () => {
    const boards = [
      ...(await Promise.all([1, 2, 3, 4].map(() => addBoard("greenhouse", mockRoles("greenhouse", 5))))),
      ...(await Promise.all([1, 2, 3].map(() => addBoard("ashby", mockRoles("ashby", 5))))),
      ...(await Promise.all([1, 2, 3].map(() => addBoard("lever", mockRoles("lever", 5))))),
    ];

    const gate = new RecordingGate({ gapMs: 1000 }); // the real rule
    const startedAt = performance.now();
    const { summary } = await pollDue({ gate });
    const tookMs = performance.now() - startedAt;

    expect(summary.outcomes.applied).toBe(10);
    for (const board of boards) expect((await boardRow(db.pool, board.id)).baselined_at).not.toBeNull();

    for (const provider of PROVIDERS) {
      const count = boards.filter((b) => b.token.startsWith(provider)).length;
      expect(mock.requestsFor(provider), provider).toHaveLength(count);
      // One request a second per host. The gate's own record is exact: each request was let through a full second after the one before.
      const letThrough = gate.released.filter((r) => r.host === mock.adapters[provider].host).map((r) => r.at);
      expect(letThrough, `${provider}: requests let through`).toHaveLength(count);
      expect(shortestGap(letThrough), `${provider}: shortest gap between requests leaving`).toBeGreaterThanOrEqual(1000 - CLOCK_ROUNDING_MS);
      // What reaches the host wobbles with how busy this machine is, so this bound is loose. It is here to catch a request that
      // skips the gate (it would land almost on top of another), not a few milliseconds of scheduling.
      expect(mock.minGapMs(provider), `${provider}: shortest gap between requests arriving`).toBeGreaterThanOrEqual(700);
      expect(mock.maxConcurrent(provider), `${provider}: most requests open at once`).toBeLessThanOrEqual(2);
    }
    // Hosts do not wait for each other: ten requests took as long as the longest queue (4 requests, 3 gaps), not ten gaps.
    expect(tookMs).toBeLessThan(7_000);
    expect(tookMs).toBeGreaterThanOrEqual(2_900);
  }, 30_000);

  it("keeps to it on every later round too, when the answers are 304s", async () => {
    const boards = await Promise.all([1, 2, 3].map(() => addBoard("ashby", mockRoles("ashby", 3))));
    await pollDue();
    await makeDue(boards.map((b) => b.id));
    const before = mock.requestsFor("ashby").length;
    const gate = new RecordingGate({ gapMs: 1000 });
    await pollDue({ gate });
    const second = mock.requestsFor("ashby").slice(before);
    expect(second).toHaveLength(3);
    expect(shortestGap(gate.released.map((r) => r.at))).toBeGreaterThanOrEqual(1000 - CLOCK_ROUNDING_MS);
    expect(shortestGap(second.map((r) => r.at))).toBeGreaterThanOrEqual(700);
  }, 30_000);

  it("identifies itself on every request", async () => {
    const { token } = await addBoard("greenhouse", mockRoles("greenhouse", 2));
    await pollDue();
    const mine = mock.requestsFor("greenhouse").filter((r) => r.token === token);
    expect(mine[0]?.userAgent).toBe("Sooner/0.1 (+local development run, no public contact yet)");
  });
});

describe("conditional requests", () => {
  it.each(PROVIDERS)("%s: the second poll sends the ETag it was given and gets a 304, which costs no bytes", async (provider) => {
    const { id, token } = await addBoard(provider, mockRoles(provider, 6));
    await pollDue();
    const etag = (await boardRow(db.pool, id)).etag;
    expect(etag).toMatch(/^W\/"/);

    await makeDue([id]);
    await pollDue();
    const [first, second] = mock.requestsFor(provider).filter((r) => r.token === token);
    expect(first?.ifNoneMatch).toBeNull();
    expect(second?.ifNoneMatch).toBe(etag);
    expect(second?.status).toBe(304);
    const runs = await pollRuns(db.pool, id);
    expect(runs.map((r) => r.http_status)).toEqual([200, 304]);
    expect(runs[1]).toMatchObject({ bytes: 0, jobs_seen: null });
  });

  it("asks 'is your copy current?' and never 'skip your cache', which would make Lever ignore the ETag and send everything again", async () => {
    const { id, token } = await addBoard("lever", mockRoles("lever", 4));
    await pollDue();
    await makeDue([id]);
    await pollDue();
    const second = mock.requestsFor("lever").filter((r) => r.token === token)[1];
    expect(second?.cacheControl).toBe("max-age=0");
    expect(second?.status).toBe(304); // Lever's quirk is on in the mock: a no-cache request would have got the whole list
  });

  it("sends the ETag of the last good answer, even after failures in between", async () => {
    const { id, token } = await addBoard("ashby", mockRoles("ashby", 3));
    await pollDue();
    const etag = (await boardRow(db.pool, id)).etag;
    mock.board("ashby", token).next({ status: 503 }, 2);
    for (let i = 0; i < 3; i++) {
      await makeDue([id]);
      await pollDue();
    }
    const requests = mock.requestsFor("ashby").filter((r) => r.token === token);
    expect(requests.map((r) => r.ifNoneMatch)).toEqual([null, etag, etag, etag]);
    expect(requests.at(-1)?.status).toBe(304);
  });

  it("reads a compressed answer and counts the size of what it decoded", async () => {
    const gz = await startMockProviders({ gzip: true });
    try {
      const token = "zipped";
      gz.board("greenhouse", token).set(mockRoles("greenhouse", 300));
      const companyId = await insertCompany(db.pool, { slug: "zipped" });
      const id = await insertBoard(db.pool, companyId, { provider: "greenhouse", token, nextPollAt: PAST });
      const fetcher = createFetcher({ userAgent: "Sooner/0.1 (+test)", gate: new HostGate({ gapMs: 0 }) });
      const { logger } = createMemoryLogger();
      await runWorker(
        { pool: db.pool, fetcher, now: () => T, random: () => 0.5, log: logger, adapters: gz.adapters },
        defaultLoopSettings({ idleMaxMs: 30, minWaitMs: 5 }),
        new AbortController().signal,
        { once: true },
      );
      expect((await openRoles(id)).length).toBe(300);
      const [run] = await pollRuns(db.pool, id);
      expect(run?.bytes).toBeGreaterThan(30_000); // decoded; the compressed body is a small fraction of that
    } finally {
      await gz.stop();
    }
  });
});

describe("a provider that misbehaves", () => {
  async function established(count = 10) {
    const board = await addBoard("ashby", mockRoles("ashby", count));
    await pollDue();
    return board;
  }

  const misbehaviours: Array<[string, Behavior]> = [
    ["answers 500", { status: 500 }],
    ["answers 429 with Retry-After", { status: 429, headers: { "retry-after": "600" } }],
    ["answers 503", { status: 503 }],
    ["sends something that is not JSON", { body: "<html>Down for maintenance</html>" }],
    ["sends JSON of the wrong shape", { body: '{"error":"gone fishing"}' }],
    ["cuts the body off halfway", { truncate: true }],
    ["never answers", { hang: true }],
    ["redirects somewhere else", { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } }],
    ["answers 404", { status: 404 }],
    ["answers 403", { status: 403 }],
  ];

  it.each(misbehaviours)("when it %s, no role is closed, nothing is announced, and the failure is written down", async (_name, behavior) => {
    const { id, token } = await established(10);
    mock.board("ashby", token).next(behavior);
    await makeDue([id]);
    const { summary } = await pollDue();

    expect(summary.outcomes.failed).toBe(1);
    expect(await openRoles(id)).toEqual(
      Array.from({ length: 10 }, (_, i) => ({ external_id: `r${i + 1}`, status: "open", missed_polls: 0 })).sort((a, b) => (a.external_id < b.external_id ? -1 : 1)),
    );
    expect(await eventsOf(db.pool, id)).toEqual([]);
    const board = await boardRow(db.pool, id);
    expect(board).toMatchObject({ consecutive_failures: 1, claim_token: null, active: true });
    expect(board.last_error).toBeTruthy();
    const runs = await pollRuns(db.pool, id);
    expect(runs.at(-1)?.error).toBeTruthy();
  });

  it("goes back to normal afterwards: the next good answer clears the failures and changes nothing else", async () => {
    const { id, token } = await established(5);
    mock.board("ashby", token).next({ status: 500 }, 3);
    for (let i = 0; i < 3; i++) {
      await makeDue([id]);
      await pollDue();
    }
    expect((await boardRow(db.pool, id)).consecutive_failures).toBe(3);

    await makeDue([id]);
    await pollDue();
    expect(await boardRow(db.pool, id)).toMatchObject({ consecutive_failures: 0, last_error: null });
    expect((await openRoles(id)).every((r) => r.status === "open")).toBe(true);
    expect(await eventsOf(db.pool, id)).toEqual([]);
  });

  it("does not let one broken board hold up the others", async () => {
    const broken = await addBoard("ashby", mockRoles("ashby", 4));
    const fine = await Promise.all([1, 2, 3].map(() => addBoard("ashby", mockRoles("ashby", 4))));
    mock.board("ashby", broken.token).always({ hang: true });
    const startedAt = performance.now();
    const { summary } = await pollDue();
    expect(summary.outcomes).toMatchObject({ applied: 3, failed: 1 });
    for (const board of fine) expect((await boardRow(db.pool, board.id)).baselined_at).not.toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(3_000); // the hang took its 400 ms timeout, not for ever
  });

  it("does not switch a board off for a single 404, and does after three half an hour apart", async () => {
    const { id, token } = await established(4);
    mock.board("ashby", token).always({ status: 404 });
    let clock = T;
    const at = (m: number) => () => new Date(T.getTime() + m * 60_000);
    for (const minutes of [10, 50]) {
      clock = minutesAfter(minutes);
      await makeDue([id]);
      await pollDue({ now: at(minutes) });
      expect((await boardRow(db.pool, id)).active).toBe(true);
    }
    await makeDue([id]);
    await pollDue({ now: at(100) });
    const board = await boardRow(db.pool, id);
    expect(board.active).toBe(false);
    expect(board.deactivated_reason).toMatch(/moved to another job-board provider/);
    expect((await openRoles(id)).every((r) => r.status === "open")).toBe(true);
    expect(clock).toBeInstanceOf(Date);
  });
});

describe("back-off", () => {
  it("follows the schedule: at least the board's rhythm, then doubling, and every six hours once degraded", async () => {
    const { id, token } = await addBoard("greenhouse", mockRoles("greenhouse", 3));
    await pollDue();
    mock.board("greenhouse", token).always({ status: 503 });

    const delays: number[] = [];
    for (let failures = 1; failures <= 9; failures++) {
      await makeDue([id]);
      await pollDue();
      const board = await boardRow(db.pool, id);
      delays.push(Math.round((board.next_poll_at.getTime() - T.getTime()) / 1000));
      expect(board.consecutive_failures).toBe(failures);
    }
    const expected = Array.from({ length: 9 }, (_, i) =>
      failureDelaySec({ failures: i + 1, intervalSec: 300, retryAfterSec: null, floorSec: 0, random: 0.5 }),
    );
    expect(delays).toEqual(expected);
    expect(delays).toEqual([300, 300, 480, 960, 1920, 3840, 7680, 21600, 21600]);
  });

  it("obeys Retry-After when it asks for longer than the schedule would", async () => {
    const { id, token } = await addBoard("ashby", mockRoles("ashby", 3));
    await pollDue();
    mock.board("ashby", token).next({ status: 429, headers: { "retry-after": "1800" } });
    await makeDue([id]);
    await pollDue();
    expect(((await boardRow(db.pool, id)).next_poll_at.getTime() - T.getTime()) / 1000).toBe(1800);
  });

  it("understands a Retry-After given as a date", async () => {
    const { id, token } = await addBoard("ashby", mockRoles("ashby", 3));
    await pollDue();
    mock.board("ashby", token).next({ status: 429, headers: { "retry-after": new Date(T.getTime() + 900_000).toUTCString() } });
    await makeDue([id]);
    await pollDue();
    expect(((await boardRow(db.pool, id)).next_poll_at.getTime() - T.getTime()) / 1000).toBe(900);
  });
});

describe("stopping in the middle of a poll", () => {
  it("cancels the request, gives the lease back and counts no failure, so the board is due again at once", async () => {
    const { id, token } = await addBoard("ashby", mockRoles("ashby", 3));
    mock.board("ashby", token).always({ delayMs: 5_000 });
    const { logger } = createMemoryLogger();
    const fetcher = createFetcher({ userAgent: "Sooner/0.1 (+test)", gate: new HostGate({ gapMs: 0 }) });
    const stop = new AbortController();
    const mark = mock.requestsFor("ashby").length;
    const running = runWorker(
      { pool: db.pool, fetcher, now: () => new Date(), random: () => 0.5, log: logger, adapters: mock.adapters },
      defaultLoopSettings({ idleMaxMs: 30, minWaitMs: 5, graceMs: 100, abortWaitMs: 2_000 }),
      stop.signal,
    );
    await waitFor(() => mock.requestsFor("ashby").length > mark, "the request to reach the mock server");
    expect((await boardRow(db.pool, id)).claim_token).not.toBeNull(); // the board is leased while the request is out

    stop.abort(); // SIGTERM
    const summary = await running;

    expect(summary.outcomes.aborted).toBe(1);
    expect(await boardRow(db.pool, id)).toMatchObject({ claim_token: null, claimed_until: null, consecutive_failures: 0, last_error: null, baselined_at: null });
    expect(await pollRuns(db.pool, id)).toEqual([]);
    await waitFor(() => mock.requestsFor("ashby").some((r) => r.token === token && r.closedEarly), "the mock server to see the connection drop");

    // Another worker would pick it up straight away.
    mock.board("ashby", token).normal();
    const next = await pollDue({ now: () => new Date() });
    expect(next.summary.outcomes.applied).toBe(1);
  }, 30_000);
});

describe("change detection over HTTP", () => {
  it("announces a new role, an edit and a close, and confirms the close with a 304 two minutes later", async () => {
    const roles = mockRoles("greenhouse", 5);
    const { id, token } = await addBoard("greenhouse", roles);
    const board = mock.board("greenhouse", token);

    await pollDue({ now: () => minutesAfter(0) }); // the baseline
    expect(await eventsOf(db.pool, id)).toEqual([]);

    // Five minutes later: one new role, one edited, one gone.
    const [first, second, third, fourth, fifth] = roles as [NormalizedJob, NormalizedJob, NormalizedJob, NormalizedJob, NormalizedJob];
    const fresh: NormalizedJob = { ...mockRoles("greenhouse", 1)[0]!, externalId: "5000", title: "Brand New Role" };
    board.set([{ ...first, title: "Edited Title" }, second, third, fourth, fresh]);
    await makeDue([id]);
    await pollDue({ now: () => minutesAfter(5) });
    expect((await eventsOf(db.pool, id)).map((e) => [e.type, e.external_id])).toEqual([
      ["updated", first.externalId], // events of one poll are in the order of the roles' IDs
      ["appeared", "5000"],
    ]);
    expect((await openRoles(id)).find((r) => r.external_id === fifth.externalId)).toMatchObject({ status: "open", missed_polls: 1 });
    expect(((await boardRow(db.pool, id)).next_poll_at.getTime() - minutesAfter(5).getTime()) / 1000).toBe(120);

    // Two minutes later the list is the same, so the provider answers 304, and that confirms the role is gone.
    await makeDue([id]);
    await pollDue({ now: () => minutesAfter(7) });
    const last = mock.requestsFor("greenhouse").filter((r) => r.token === token).at(-1);
    expect(last?.status).toBe(304);
    expect((await eventsOf(db.pool, id)).at(-1)).toMatchObject({ type: "closed", external_id: fifth.externalId, detail: { strikes: 2, suspicious: false } });
    expect((await openRoles(id)).find((r) => r.external_id === fifth.externalId)?.status).toBe("closed");
  });

  it("holds back a board that suddenly lists nothing, and closes nothing for twenty minutes", async () => {
    const { id, token } = await addBoard("ashby", mockRoles("ashby", 8));
    await pollDue({ now: () => minutesAfter(0) });
    mock.board("ashby", token).set([]);
    for (const minutes of [5, 15, 25]) {
      await makeDue([id]);
      await pollDue({ now: () => minutesAfter(minutes) });
      const closed = (await openRoles(id)).filter((r) => r.status === "closed").length;
      expect(closed).toBe(minutes === 25 ? 8 : 0);
    }
    expect((await pollRuns(db.pool, id))[1]?.note).toMatch(/8 of 8 open roles vanished at once/);
  });
});

import { describe, expect, it } from "vitest";
import { adapters } from "../core/adapters/index.ts";
import { PROVIDERS, type Provider } from "../core/types.ts";
import { T0 } from "../core/test-utils.ts";
import type { Pool } from "../db/pool.ts";
import { testDatabase } from "../db/testing/database.ts";
import { insertBoard, insertCompany } from "../db/testing/factories.ts";
import type { FetchOutcome } from "./fetcher.ts";
import { createMemoryLogger } from "./log.ts";
import { defaultLoopSettings, leaseSecFor, runWorker, type LoopSettings } from "./loop.ts";
import { createLiveness } from "./heartbeat.ts";
import { bodyFor, boardRow, notModifiedAnswer, okAnswer, pollRuns, retryAnswer, scriptedFetcher, waitFor, type FetchCall } from "./testing.ts";

const db = testDatabase();

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const secondsAfterStart = (s: number): string => new Date(T0 + s * 1000).toISOString();

/** Quick settings for tests: short sleeps, short grace. */
const settings = (over: Partial<LoopSettings> = {}): LoopSettings =>
  defaultLoopSettings({ idleMaxMs: 40, minWaitMs: 5, graceMs: 300, abortWaitMs: 300, errorWaitMs: 20, followed: true, ...over });

let counter = 0;
async function seedBoards(provider: Provider, count: number, over: { nextPollAt?: string } = {}): Promise<string[]> {
  const companyId = await insertCompany(db.pool, { slug: `co-${++counter}` });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(await insertBoard(db.pool, companyId, { provider, token: `${provider}-${++counter}`, nextPollAt: over.nextPollAt ?? secondsAfterStart(-60) }));
  }
  return ids;
}

function providerOf(url: string): Provider {
  const found = PROVIDERS.find((p) => url.startsWith(`https://${adapters[p].host}/`));
  if (!found) throw new Error(`no provider for ${url}`);
  return found;
}

const respond = (call: FetchCall): FetchOutcome => okAnswer(bodyFor(providerOf(call.url), 3));

function context(over: { now?: () => Date; pool?: Pool } = {}) {
  const { logger, entries } = createMemoryLogger();
  return { entries, logger, now: over.now ?? (() => new Date(T0)), random: () => 0.5, pool: over.pool ?? db.pool };
}

describe("a pass over the due boards", () => {
  it("polls every due board of every provider and then stops, when asked to run once", async () => {
    const boards = [...(await seedBoards("greenhouse", 3)), ...(await seedBoards("lever", 2)), ...(await seedBoards("ashby", 4))];
    const fetcher = scriptedFetcher(respond);
    const ctx = context();
    const summary = await runWorker({ ...ctx, fetcher, log: ctx.logger }, settings(), new AbortController().signal, { once: true });

    expect(summary.claimed).toBe(9);
    expect(summary.outcomes).toMatchObject({ applied: 9, failed: 0 });
    expect(fetcher.calls).toHaveLength(9);
    for (const id of boards) {
      const board = await boardRow(db.pool, id);
      expect(board.last_polled_at?.toISOString()).toBe(new Date(T0).toISOString());
      expect(board.claim_token).toBeNull();
      expect(board.baselined_at).not.toBeNull();
    }
  });

  it("finds nothing more to do straight afterwards, because every board was rescheduled", async () => {
    await seedBoards("ashby", 3);
    const fetcher = scriptedFetcher(respond);
    const ctx = context();
    await runWorker({ ...ctx, fetcher, log: ctx.logger }, settings(), new AbortController().signal, { once: true });
    const again = await runWorker({ ...ctx, fetcher, log: ctx.logger }, settings(), new AbortController().signal, { once: true });
    expect(again.claimed).toBe(0);
    expect(fetcher.calls).toHaveLength(3);
  });

  it("returns at once when there is nothing due", async () => {
    await seedBoards("ashby", 2, { nextPollAt: secondsAfterStart(3600) });
    const ctx = context();
    const startedAt = performance.now();
    const summary = await runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger }, settings(), new AbortController().signal, { once: true });
    expect(summary.claimed).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it("keeps a simulated day in order: 200, then 304s, one poll per board per five minutes", async () => {
    const [id] = await seedBoards("ashby", 1);
    const fetcher = scriptedFetcher((call) => (call.options.etag ? notModifiedAnswer() : okAnswer(bodyFor("ashby", 3))));
    let clock = T0;
    const ctx = context({ now: () => new Date(clock) });
    for (let i = 0; i < 4; i++) {
      await runWorker({ ...ctx, fetcher, log: ctx.logger }, settings(), new AbortController().signal, { once: true });
      clock += 301_000; // just over five minutes later
    }
    expect((await pollRuns(db.pool, id as string)).map((r) => r.http_status)).toEqual([200, 304, 304, 304]);
    expect(fetcher.calls.map((c) => c.options.etag ?? null)).toEqual([null, 'W/"1"', 'W/"1"', 'W/"1"']);
  });
});

describe("which boards are polled fast", () => {
  it("polls a priority board every five minutes while an ordinary one slows down, when nothing is followed", async () => {
    const companyId = await insertCompany(db.pool, { slug: "pair" });
    const fast = await insertBoard(db.pool, companyId, { provider: "ashby", token: "fast", nextPollAt: secondsAfterStart(-60), priority: true });
    const slow = await insertBoard(db.pool, companyId, { provider: "ashby", token: "slow", nextPollAt: secondsAfterStart(-60) });
    const ctx = context();
    await runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger }, settings({ followed: false }), new AbortController().signal, { once: true });

    const gap = async (id: string) => ((await boardRow(db.pool, id)).next_poll_at.getTime() - T0) / 1000;
    expect(await gap(fast)).toBeGreaterThanOrEqual(270); // five minutes, give or take the jitter
    expect(await gap(fast)).toBeLessThanOrEqual(330);
    expect(await gap(slow)).toBeGreaterThanOrEqual(1620); // thirty minutes after the baseline, give or take the jitter
    expect(await gap(slow)).toBeLessThanOrEqual(1980);
  });

  it("polls everything every five minutes when every board is followed", async () => {
    const [id] = await seedBoards("ashby", 1);
    const ctx = context();
    await runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger }, settings({ followed: true }), new AbortController().signal, { once: true });
    expect(((await boardRow(db.pool, id as string)).next_poll_at.getTime() - T0) / 1000).toBeLessThanOrEqual(330);
  });
});

describe("the lanes", () => {
  it("never runs more polls of one provider at once than its lane allows, and still gets through them all", async () => {
    await seedBoards("ashby", 9);
    let running = 0;
    let peak = 0;
    const fetcher = scriptedFetcher(async (call) => {
      running++;
      peak = Math.max(peak, running);
      await delay(25);
      running--;
      return respond(call);
    });
    const ctx = context();
    const summary = await runWorker({ ...ctx, fetcher, log: ctx.logger }, settings({ lanes: { greenhouse: 4, lever: 3, ashby: 3 } }), new AbortController().signal, { once: true });
    expect(summary.outcomes.applied).toBe(9);
    expect(peak).toBe(3);
  });

  it("does not let a slow provider hold up a fast one", async () => {
    const levers = await seedBoards("lever", 3);
    const ashbys = await seedBoards("ashby", 3);
    let releaseLever: () => void = () => undefined;
    const leverGate = new Promise<void>((resolve) => (releaseLever = resolve));
    const fetcher = scriptedFetcher(async (call) => {
      if (providerOf(call.url) === "lever") await leverGate;
      return respond(call);
    });
    const ctx = context();
    const done = runWorker({ ...ctx, fetcher, log: ctx.logger }, settings({ lanes: { greenhouse: 4, lever: 2, ashby: 4 } }), new AbortController().signal, { once: true });

    // While two Lever polls are stuck, all the Ashby boards are polled.
    await waitFor(
      async () => (await Promise.all(ashbys.map((id) => boardRow(db.pool, id)))).every((board) => board.last_polled_at !== null),
      "every Ashby board to be polled",
    );
    for (const id of ashbys) expect((await boardRow(db.pool, id)).last_polled_at).not.toBeNull();
    for (const id of levers) expect((await boardRow(db.pool, id)).last_polled_at).toBeNull();

    releaseLever();
    const summary = await done;
    expect(summary.outcomes.applied).toBe(6); // the third Lever board was claimed as soon as a Lever lane freed up
  });

  it("works out its leases from how long a poll of that provider can take", () => {
    expect(leaseSecFor("greenhouse", 4)).toBe(30 * 2 + 60);
    expect(leaseSecFor("ashby", 4)).toBe(30 * 2 + 60);
    expect(leaseSecFor("lever", 3)).toBe(120 * 2 + 60);
    expect(leaseSecFor("lever", 1)).toBe(120 + 60);
  });
});

describe("liveness, which the heartbeat depends on", () => {
  it("is touched by every pass of the loop", async () => {
    await seedBoards("ashby", 2);
    const liveness = createLiveness();
    expect(liveness.idleMs()).toBeNull();
    const ctx = context();
    await runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger, liveness }, settings(), new AbortController().signal, { once: true });
    expect(liveness.idleMs()).not.toBeNull();
    expect(liveness.idleMs() as number).toBeLessThan(2000);
  });

  it("is touched while polling is switched off: idle on purpose is not stuck", async () => {
    const liveness = createLiveness();
    const stop = new AbortController();
    const ctx = context();
    const running = runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger, liveness }, settings({ pollingEnabled: false }), stop.signal);
    await waitFor(() => liveness.idleMs() !== null, "the idle loop to show it is alive");
    stop.abort();
    await running;
  });

  it("is not touched while every pass fails, so a worker that cannot reach its database stops sending the heartbeat", async () => {
    const liveness = createLiveness();
    const broken = new Proxy(db.pool, {
      get(target, property, receiver) {
        if (property === "query") return () => Promise.reject(new Error("connection refused"));
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const stop = new AbortController();
    const ctx = context({ pool: broken });
    const running = runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger, liveness }, settings(), stop.signal);
    await waitFor(() => ctx.entries.filter((e) => e.msg === "the worker loop hit an error; retrying shortly").length >= 3, "three failed passes");
    stop.abort();
    await running;
    expect(liveness.idleMs()).toBeNull();
  });
});

describe("the kill switch", () => {
  it("claims nothing while polling is switched off", async () => {
    await seedBoards("ashby", 2);
    const fetcher = scriptedFetcher(respond);
    const ctx = context();
    const summary = await runWorker({ ...ctx, fetcher, log: ctx.logger }, settings({ pollingEnabled: false }), new AbortController().signal, { once: true });
    expect(summary.claimed).toBe(0);
    expect(fetcher.calls).toHaveLength(0);
    expect(ctx.entries.some((e) => e.level === "warn" && /POLLING_ENABLED=false/.test(e.msg))).toBe(true);
  });

  it("stays up and idle until it is told to stop", async () => {
    await seedBoards("ashby", 2);
    const stop = new AbortController();
    const ctx = context();
    const running = runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger }, settings({ pollingEnabled: false }), stop.signal);
    await delay(150);
    stop.abort();
    expect((await running).claimed).toBe(0);
  });
});

describe("stopping", () => {
  it("lets the polls in flight finish and apply, then returns with no lease left behind", async () => {
    const ids = await seedBoards("ashby", 3);
    const stop = new AbortController();
    const fetcher = scriptedFetcher(async (call) => {
      await delay(120);
      return respond(call);
    });
    const ctx = context();
    const running = runWorker({ ...ctx, fetcher, log: ctx.logger }, settings({ graceMs: 2000 }), stop.signal);
    await waitFor(() => fetcher.calls.length === 3, "the three polls to be in flight");
    stop.abort();
    const summary = await running;

    expect(summary.outcomes.applied).toBe(3);
    expect(summary.released).toBe(0);
    for (const id of ids) {
      const board = await boardRow(db.pool, id);
      expect(board.claim_token).toBeNull();
      expect(board.baselined_at).not.toBeNull();
    }
  });

  it("cancels polls that take too long and gives their boards back, without counting a failure", async () => {
    const ids = await seedBoards("ashby", 2);
    const stop = new AbortController();
    const fetcher = scriptedFetcher(
      (call) =>
        new Promise<FetchOutcome>((resolve) => {
          // Never answers on its own; answers "aborted" when the worker cancels it, as the real fetcher does.
          call.options.signal?.addEventListener("abort", () => resolve(retryAnswer("aborted", null, null)), { once: true });
        }),
    );
    const ctx = context();
    const running = runWorker({ ...ctx, fetcher, log: ctx.logger }, settings({ graceMs: 80 }), stop.signal);
    await waitFor(() => fetcher.calls.length === 2, "both polls to be in flight");
    stop.abort();
    const summary = await running;

    expect(summary.outcomes.aborted).toBe(2);
    for (const id of ids) {
      expect(await boardRow(db.pool, id)).toMatchObject({ claim_token: null, claimed_until: null, consecutive_failures: 0, last_error: null, baselined_at: null });
      expect(await pollRuns(db.pool, id)).toEqual([]);
    }
    // The boards are due again at once, so the next worker picks them up.
    const next = context();
    const again = await runWorker({ ...next, fetcher: scriptedFetcher(respond), log: next.logger }, settings(), new AbortController().signal, { once: true });
    expect(again.claimed).toBe(2);
  });

  it("releases the leases by force when a poll ignores the cancellation", async () => {
    const [id] = await seedBoards("ashby", 1);
    const stop = new AbortController();
    const fetcher = scriptedFetcher(() => new Promise<FetchOutcome>(() => undefined)); // hangs forever
    const ctx = context();
    const running = runWorker({ ...ctx, fetcher, log: ctx.logger }, settings({ graceMs: 40, abortWaitMs: 40 }), stop.signal);
    await waitFor(() => fetcher.calls.length === 1, "the poll to be in flight");
    stop.abort();
    const summary = await running;

    expect(summary.released).toBe(1);
    expect(await boardRow(db.pool, id as string)).toMatchObject({ claim_token: null, claimed_until: null });
  });
});

describe("recovering", () => {
  it("takes over a board whose worker crashed, once its lease has run out", async () => {
    const companyId = await insertCompany(db.pool);
    const id = await insertBoard(db.pool, companyId, {
      provider: "ashby",
      token: "orphan",
      nextPollAt: secondsAfterStart(-600),
      claimedUntil: secondsAfterStart(-30),
      claimToken: "6c8e0a34-6b1e-4f43-9a09-7a8f0f7d2a11",
    });
    const ctx = context();
    const summary = await runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger }, settings(), new AbortController().signal, { once: true });
    expect(summary.claimed).toBe(1);
    expect((await boardRow(db.pool, id)).baselined_at).not.toBeNull();
  });

  it("leaves a board alone while another worker's lease on it is still good", async () => {
    const companyId = await insertCompany(db.pool);
    await insertBoard(db.pool, companyId, {
      provider: "ashby",
      token: "busy",
      nextPollAt: secondsAfterStart(-600),
      claimedUntil: secondsAfterStart(300),
      claimToken: "6c8e0a34-6b1e-4f43-9a09-7a8f0f7d2a11",
    });
    const ctx = context();
    const summary = await runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger }, settings(), new AbortController().signal, { once: true });
    expect(summary.claimed).toBe(0);
  });

  it("keeps going when the database errors, and picks the work up once it is back", async () => {
    await seedBoards("ashby", 2);
    let failures = 2;
    const flaky = new Proxy(db.pool, {
      get(target, property, receiver) {
        if (property === "query") {
          return (...args: unknown[]) => {
            if (failures > 0) {
              failures--;
              return Promise.reject(new Error("connection refused"));
            }
            return (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const ctx = context({ pool: flaky });
    const summary = await runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger }, settings(), new AbortController().signal, { once: true });

    expect(summary.outcomes.applied).toBe(2);
    expect(ctx.entries.filter((e) => e.msg === "the worker loop hit an error; retrying shortly")).toHaveLength(2);
  });
});

describe("housekeeping", () => {
  it("deletes poll runs older than a week as it goes", async () => {
    const [id] = await seedBoards("ashby", 1, { nextPollAt: secondsAfterStart(3600) });
    await db.pool.query("insert into poll_run (board_id, started_at, http_status) values ($1, $2, 200), ($1, $3, 200)", [
      id,
      new Date(T0 - 30 * 86_400_000).toISOString(),
      new Date(T0 - 1 * 86_400_000).toISOString(),
    ]);
    const ctx = context();
    await runWorker({ ...ctx, fetcher: scriptedFetcher(respond), log: ctx.logger }, settings({ maintenanceEveryMs: 0 }), new AbortController().signal, { once: true });
    const runs = await db.pool.query<{ n: number }>("select count(*)::int as n from poll_run");
    expect(runs.rows[0]?.n).toBe(1);
  });
});

import { adapters } from "../core/adapters/index.ts";
import { PROVIDERS, type Provider } from "../core/types.ts";
import type { Pool } from "../db/pool.ts";
import { claimDueBoards, earliestClaimableAt, releaseLeases } from "./claim.ts";
import type { Fetcher } from "./fetcher.ts";
import { DEFAULT_MAX_IN_FLIGHT } from "./gate.ts";
import type { Logger } from "./log.ts";
import { pollClaimedBoard, type PollTaskOutcome } from "./poll-task.ts";
import { pruneOldPollRuns } from "./settle.ts";
import type { ClaimedBoard } from "./types.ts";
import { Wakeup } from "./wakeup.ts";

/**
 * How many boards of each provider this worker takes at a time. The politeness gate already limits requests to one host
 * (one per second, two at once), so a lane a little longer than the gate's cap just keeps the gate busy. Separate lanes
 * matter because providers differ by a factor of fifty in speed: with one shared limit, eight slow Lever boards would sit
 * on every slot and no Greenhouse board could be polled until they finished.
 */
export const DEFAULT_LANES: Readonly<Record<Provider, number>> = { greenhouse: 4, ashby: 4, lever: 3 };

/**
 * How long a lease lasts. A claimed board can wait in the gate behind others and then take a whole timeout to answer, so
 * the lease covers every turn the lane can queue for, plus a minute for the database work. A worker that crashes holds
 * its boards no longer than this.
 */
export function leaseSecFor(provider: Provider, lane: number): number {
  const turns = Math.ceil(lane / DEFAULT_MAX_IN_FLIGHT);
  return Math.ceil(adapters[provider].timeoutMs / 1000) * turns + 60;
}

export interface LoopSettings {
  lanes: Record<Provider, number>;
  leaseSec: Record<Provider, number>;
  /** Treat every board as followed (polled every five minutes). */
  followed: boolean;
  /** false: stay up, claim nothing. The kill switch. */
  pollingEnabled: boolean;
  /** The longest the loop sleeps when nothing is due, so changes made elsewhere are noticed. */
  idleMaxMs: number;
  /** The shortest sleep between passes, so a board that is due but taken by someone else does not make the loop spin. */
  minWaitMs: number;
  /** When told to stop, how long polls in flight get to finish. */
  graceMs: number;
  /** After that, how long cancelled polls get to put their leases back. */
  abortWaitMs: number;
  /** How long the loop waits before trying again after an error, most likely an unreachable database. */
  errorWaitMs: number;
  maintenanceEveryMs: number;
}

export function defaultLoopSettings(overrides: Partial<LoopSettings> = {}): LoopSettings {
  const lanes = { ...DEFAULT_LANES, ...overrides.lanes };
  return {
    lanes,
    leaseSec: {
      greenhouse: leaseSecFor("greenhouse", lanes.greenhouse),
      lever: leaseSecFor("lever", lanes.lever),
      ashby: leaseSecFor("ashby", lanes.ashby),
      ...overrides.leaseSec,
    },
    followed: true,
    pollingEnabled: true,
    idleMaxMs: 15_000,
    minWaitMs: 100,
    graceMs: 25_000,
    abortWaitMs: 5_000,
    errorWaitMs: 5_000,
    maintenanceEveryMs: 3_600_000,
    ...overrides,
  };
}

export interface LoopDeps {
  pool: Pool;
  fetcher: Fetcher;
  now: () => Date;
  random: () => number;
  log: Logger;
}

export interface LoopSummary {
  /** Boards claimed over the whole run. */
  claimed: number;
  outcomes: Record<PollTaskOutcome, number>;
  /** Leases that had to be handed back by force at shutdown. */
  released: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The worker: ask Postgres "which boards are due?", poll them politely, and let each poll schedule the board's next visit.
 * Postgres is the queue, so there is nothing else to run.
 *
 * Each pass claims, for every provider with room in its lane, as many due boards as there is room for, and starts a poll
 * for each. Then it sleeps until the next board falls due, or until a poll finishes and frees a lane, or until it is told
 * to stop. It queries the database when there is something to do, not on a timer.
 *
 * When `signal` fires the loop stops claiming, lets polls in flight finish (up to `graceMs`), cancels the rest and gives
 * their leases back, so the boards are due again at once for whoever runs next. With `once`, it instead returns when
 * nothing is due and nothing is running.
 */
export async function runWorker(
  deps: LoopDeps,
  settings: LoopSettings,
  signal: AbortSignal,
  options: { once?: boolean } = {},
): Promise<LoopSummary> {
  const { log } = deps;
  const wake = new Wakeup();
  const active: Record<Provider, number> = { greenhouse: 0, lever: 0, ashby: 0 };
  const running = new Map<string, Promise<void>>();
  const claims = new Map<string, ClaimedBoard>();
  const cancelPolls = new AbortController();
  const summary: LoopSummary = {
    claimed: 0,
    outcomes: { applied: 0, held: 0, failed: 0, "lease-lost": 0, aborted: 0 },
    released: 0,
  };
  let lastMaintenance = deps.now().getTime();

  function start(board: ClaimedBoard): void {
    active[board.provider]++;
    summary.claimed++;
    claims.set(board.claimToken, board);
    const task = pollClaimedBoard(
      { pool: deps.pool, fetcher: deps.fetcher, now: deps.now, random: deps.random, log, followed: settings.followed, signal: cancelPolls.signal },
      board,
    )
      .then((outcome) => {
        summary.outcomes[outcome]++;
      })
      .catch((error: unknown) => {
        // pollClaimedBoard is written never to throw. If it does, the lease runs out and the board is tried again.
        log.error("a poll crashed", { board_id: board.id, company: board.companySlug, error });
      })
      .finally(() => {
        active[board.provider]--;
        claims.delete(board.claimToken);
        running.delete(board.claimToken);
        wake.notify();
      });
    running.set(board.claimToken, task);
  }

  if (!settings.pollingEnabled) log.warn("polling is switched off (POLLING_ENABLED=false); the worker is idle");
  log.info("worker started", { lanes: settings.lanes, followed: settings.followed, once: options.once ?? false });

  while (!signal.aborted) {
    if (!settings.pollingEnabled) {
      if (options.once) break;
      await wake.wait(settings.idleMaxMs, signal);
      continue;
    }

    try {
      let claimedThisPass = 0;
      const withRoom: Provider[] = [];
      for (const provider of PROVIDERS) {
        const room = settings.lanes[provider] - active[provider];
        if (room <= 0) continue;
        withRoom.push(provider);
        const boards = await claimDueBoards(deps.pool, { provider, limit: room, now: deps.now(), leaseSec: settings.leaseSec[provider] });
        for (const board of boards) start(board);
        claimedThisPass += boards.length;
      }

      if (deps.now().getTime() - lastMaintenance >= settings.maintenanceEveryMs) {
        lastMaintenance = deps.now().getTime();
        const deleted = await pruneOldPollRuns(deps.pool, deps.now());
        if (deleted > 0) log.info("deleted old poll runs", { deleted });
      }

      if (options.once && claimedThisPass === 0 && running.size === 0) break;

      // Sleep until the next board that this worker could take falls due. A lane that is full is not waited for: its
      // next poll to finish wakes the loop.
      let waitMs = settings.idleMaxMs;
      if (withRoom.length > 0) {
        const next = await earliestClaimableAt(deps.pool, withRoom);
        if (next) waitMs = Math.min(waitMs, Math.max(settings.minWaitMs, next.getTime() - deps.now().getTime()));
      }
      await wake.wait(waitMs, signal);
    } catch (error) {
      // Most likely the database is unreachable. Polls in flight keep going; try again shortly.
      log.error("the worker loop hit an error; retrying shortly", { error });
      await wake.wait(settings.errorWaitMs, signal);
    }
  }

  if (running.size > 0) {
    log.info("stopping; waiting for polls in flight", { in_flight: running.size, grace_ms: settings.graceMs });
    await Promise.race([Promise.allSettled([...running.values()]), delay(settings.graceMs)]);
    if (running.size > 0) {
      log.warn("cancelling polls that did not finish in time", { in_flight: running.size });
      cancelPolls.abort(new Error("the worker is shutting down"));
      await Promise.race([Promise.allSettled([...running.values()]), delay(settings.abortWaitMs)]);
    }
    if (claims.size > 0) {
      try {
        summary.released = await releaseLeases(deps.pool, [...claims.keys()]);
        log.warn("released leases by force", { released: summary.released });
      } catch (error) {
        log.error("could not release leases; they will run out on their own", { error });
      }
    }
  }
  log.info("worker stopped", { claimed: summary.claimed, ...summary.outcomes });
  return summary;
}

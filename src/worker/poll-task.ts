import { adapters } from "../core/adapters/index.ts";
import type { Pool } from "../db/pool.ts";
import { releaseLeases } from "./claim.ts";
import { fetchBoard, type BoardFetch } from "./fetch-board.ts";
import type { Fetcher } from "./fetcher.ts";
import type { Logger } from "./log.ts";
import { oneLine } from "./sanitize.ts";
import { recordFailure, settlePoll, type PollFailure, type PollMeta, type SettleOptions, type SettleResult } from "./settle.ts";
import type { ClaimedBoard } from "./types.ts";

export interface PollTaskDeps {
  pool: Pool;
  fetcher: Fetcher;
  now: () => Date;
  /** A number in [0, 1), for jitter. */
  random: () => number;
  log: Logger;
  /** Treat every board as followed. A board can also be followed on its own account: see ClaimedBoard.priority. */
  followed: boolean;
  /** Fires when the worker gives up waiting for polls in flight. The request is cancelled and the lease is given back. */
  signal: AbortSignal;
  /** Passed on to settlePoll. Only tests set it. */
  beforeCommit?: SettleOptions["beforeCommit"];
}

export type PollTaskOutcome = "applied" | "held" | "failed" | "lease-lost" | "aborted";

/**
 * Polls one board that has been claimed, from the request to the lease being given back:
 *
 *   fetch (conditional, polite) -> parse (inside fetchBoard) -> apply in one transaction -> reschedule
 *
 * Whatever goes wrong ends the same way: nothing about the board's roles changes, the failure is written down, and the
 * board is tried again later. It never throws, because one bad board must not stop the others.
 */
export async function pollClaimedBoard(deps: PollTaskDeps, board: ClaimedBoard): Promise<PollTaskOutcome> {
  const { log } = deps;
  const adapter = adapters[board.provider];
  const startedAt = deps.now();
  const who = { board_id: board.id, company: board.companySlug, provider: board.provider };

  let fetched: BoardFetch;
  try {
    fetched = await fetchBoard(deps.fetcher, board, { signal: deps.signal });
  } catch (error) {
    // fetchBoard turns every provider problem into a result, so reaching here means a bug in our own code.
    log.error("fetching crashed", { ...who, error });
    return fail(deps, board, { kind: "retry", reason: `unexpected error: ${errorText(error)}`, retryAfterSec: null }, { startedAt, status: null, ms: 0, bytes: 0 });
  }

  const meta: PollMeta = { startedAt, status: fetched.status, ms: fetched.ms, bytes: fetched.bytes };

  if (deps.signal.aborted) {
    await giveBack(deps, board);
    log.info("poll cancelled by shutdown; lease released", who);
    return "aborted";
  }

  if (fetched.kind === "retry" || fetched.kind === "error" || fetched.kind === "invalid") {
    const failure: PollFailure = {
      kind: fetched.kind,
      reason: fetched.reason,
      retryAfterSec: fetched.kind === "retry" ? fetched.retryAfterSec : null,
    };
    return fail(deps, board, failure, meta);
  }

  try {
    const result = await settlePoll(
      deps.pool,
      board,
      fetched.kind === "ok" ? { kind: "snapshot", jobs: fetched.jobs, etag: fetched.etag } : { kind: "unchanged" },
      meta,
      {
        now: deps.now(),
        followed: deps.followed || board.priority,
        floorSec: adapter.minIntervalSec,
        random: deps.random(),
        beforeCommit: deps.beforeCommit,
      },
    );
    return report(deps, who, meta, result);
  } catch (error) {
    // The transaction rolled back, so nothing was applied. Record the failure so the board backs off instead of retrying hot.
    log.error("applying the poll failed; nothing was changed", { ...who, error });
    return fail(deps, board, { kind: "retry", reason: `database error: ${errorText(error)}`, retryAfterSec: null }, meta);
  }
}

function report(deps: PollTaskDeps, who: Record<string, unknown>, meta: PollMeta, result: SettleResult): PollTaskOutcome {
  if (result.outcome === "lease-lost") {
    deps.log.warn("the lease was lost to another worker; nothing was written", who);
    return "lease-lost";
  }
  if (result.outcome === "held") {
    deps.log.warn("the first poll listed no roles; the board is not baselined yet", { ...who, status: meta.status });
    return "held";
  }
  const { counts } = result;
  deps.log.info("poll", {
    ...who,
    status: meta.status,
    ms: meta.ms,
    bytes: meta.bytes,
    baseline: result.baseline,
    changed: result.baseline || Object.values(counts).some((n) => n > 0),
    jobs_seen: result.jobsSeen,
    open: result.openRoles,
    appeared: counts.appeared,
    reposted: counts.reposted,
    updated: counts.updated,
    closed: counts.closed,
    reopened: counts.reopened,
    on_strike: result.onStrike,
    next_poll_in_s: result.nextPollAt ? Math.round((result.nextPollAt.getTime() - deps.now().getTime()) / 1000) : null,
  });
  if (result.suspicious) {
    deps.log.warn("many roles vanished at once; closing is held back for three checks over twenty minutes", {
      ...who,
      open: result.suspicious.open,
      missing: result.suspicious.missing,
    });
  }
  return "applied";
}

async function fail(deps: PollTaskDeps, board: ClaimedBoard, failure: PollFailure, meta: PollMeta): Promise<PollTaskOutcome> {
  const who = { board_id: board.id, company: board.companySlug, provider: board.provider };
  try {
    const result = await recordFailure(deps.pool, board, failure, meta, {
      now: deps.now(),
      floorSec: adapters[board.provider].minIntervalSec,
      random: deps.random(),
    });
    if (result.outcome === "lease-lost") {
      deps.log.warn("the lease was lost to another worker; the failure was not recorded", who);
      return "lease-lost";
    }
    if (result.deactivated) {
      deps.log.error("board switched off: it keeps answering 404, so the company has probably moved to another provider", {
        ...who,
        status: meta.status,
      });
    }
    // A feed that stopped looking like itself needs a human; a timeout or a 503 will most likely pass.
    const level = failure.kind === "invalid" ? "error" : "warn";
    deps.log[level]("poll failed", {
      ...who,
      kind: failure.kind,
      status: meta.status,
      ms: meta.ms,
      reason: oneLine(failure.reason),
      failures: result.failures,
      next_poll_in_s: result.nextPollAt ? Math.round((result.nextPollAt.getTime() - deps.now().getTime()) / 1000) : null,
    });
  } catch (error) {
    // Even writing the failure failed (the database is probably down). The lease runs out by itself and the board is tried again.
    deps.log.error("could not record the failure; the lease will run out on its own", { ...who, error });
  }
  return "failed";
}

/** Gives the lease back without recording a poll: the worker is stopping and this board is still due. */
async function giveBack(deps: PollTaskDeps, board: ClaimedBoard): Promise<void> {
  try {
    await releaseLeases(deps.pool, [board.claimToken]);
  } catch (error) {
    deps.log.error("could not release a lease", { board_id: board.id, error });
  }
}

const errorText = (error: unknown): string => oneLine(error instanceof Error ? error.message : String(error), 200);

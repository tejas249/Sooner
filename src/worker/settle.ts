import { applySnapshot, confirmPending, type ApplyResult } from "../core/changes.ts";
import { GONE_REASON } from "../core/health.ts";
import { eventRecords, planWrites, strikesOf, type EventType } from "../core/persist.ts";
import { NOT_FOUND_LIMIT, NOT_FOUND_MIN_WAIT_SEC, failureDelaySec, scheduleAfterSuccess } from "../core/schedule.ts";
import type { NormalizedJob } from "../core/types.ts";
import { withTransaction, type Client, type Pool, type Queryable } from "../db/pool.ts";
import { loadBoardState, writeChanges } from "./postings.ts";
import { oneLine } from "./sanitize.ts";
import type { ClaimedBoard } from "./types.ts";

/** What the board answered. A snapshot is the full list of open roles; "unchanged" is a 304. */
export type PollAnswer = { kind: "snapshot"; jobs: readonly NormalizedJob[]; etag: string | null } | { kind: "unchanged" };

/** How the request went, for the poll_run row. */
export interface PollMeta {
  startedAt: Date;
  status: number | null;
  ms: number;
  bytes: number;
}

export interface SettleOptions {
  /** The moment the answer arrived. Everything the reducer decides is relative to it. */
  now: Date;
  followed: boolean;
  /** The provider's own minimum interval. */
  floorSec: number;
  /** A number in [0, 1), for jitter. */
  random: number;
  /** Runs after everything is written and before the commit. A test uses it to prove that a crash here applies nothing. */
  beforeCommit?: (client: Client) => Promise<void>;
}

export type EventCounts = Record<EventType, number>;
const noEvents = (): EventCounts => ({ appeared: 0, updated: 0, closed: 0, reopened: 0, reposted: 0 });

export interface SettleResult {
  /**
   * applied: the answer was written. held: this was the first poll and the board listed no roles, which is not enough to
   * baseline it. lease-lost: another worker has taken the board over, so nothing was written.
   */
  outcome: "applied" | "held" | "lease-lost";
  baseline: boolean;
  counts: EventCounts;
  jobsSeen: number | null;
  openRoles: number;
  onStrike: number;
  suspicious: ApplyResult["suspicious"];
  intervalSec: number;
  nextPollAt: Date | null;
}

const LEASE_LOST: SettleResult = {
  outcome: "lease-lost",
  baseline: false,
  counts: noEvents(),
  jobsSeen: null,
  openRoles: 0,
  onStrike: 0,
  suspicious: null,
  intervalSec: 0,
  nextPollAt: null,
};

/** Limits for the transaction itself, so a stuck statement or lock fails the poll instead of holding the lease forever. */
async function limitTransaction(client: Queryable): Promise<void> {
  await client.query("set local statement_timeout = '60s'");
  await client.query("set local lock_timeout = '10s'");
  await client.query("set local idle_in_transaction_session_timeout = '120s'");
}

/** Takes the board's row lock, but only if this worker still holds the lease. */
async function lockBoard(client: Queryable, board: ClaimedBoard) {
  const { rows } = await client.query<{ baselined_at: Date | null; poll_interval_sec: number }>(
    "select baselined_at, poll_interval_sec from board where id = $1 and claim_token = $2 for update",
    [board.id, board.claimToken],
  );
  return rows[0] ?? null;
}

/** How long after it fell due the poll started, in milliseconds. Never negative. */
export function queueLagMs(board: ClaimedBoard, startedAt: Date): number {
  return Math.max(0, Math.round(startedAt.getTime() - Date.parse(board.dueAt)));
}

async function recordPollRun(
  db: Queryable,
  board: ClaimedBoard,
  meta: PollMeta,
  fields: { jobsSeen: number | null; newCount: number; closedCount: number; error: string | null; note: string | null },
): Promise<void> {
  await db.query(
    `insert into poll_run (board_id, started_at, queue_lag_ms, duration_ms, http_status, bytes, jobs_seen, new_count, closed_count, error, note)
     values ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      board.id,
      meta.startedAt.toISOString(),
      queueLagMs(board, meta.startedAt),
      meta.ms,
      meta.status,
      meta.bytes,
      fields.jobsSeen,
      fields.newCount,
      fields.closedCount,
      fields.error,
      fields.note,
    ],
  );
}

/**
 * Finishes a poll that got a good answer. The diff, the new ETag, the next poll time and the release of the lease all go
 * in one transaction: a crash leaves either everything applied or nothing, and applying the same answer twice changes
 * nothing the second time.
 *
 * The first thing it does is lock the board's row, conditional on the lease token. A worker that stalled past its lease
 * and lost the board to another worker finds no row and writes nothing.
 */
export async function settlePoll(
  pool: Pool,
  board: ClaimedBoard,
  answer: PollAnswer,
  meta: PollMeta,
  options: SettleOptions,
): Promise<SettleResult> {
  return withTransaction(pool, async (client) => {
    await limitTransaction(client);
    const locked = await lockBoard(client, board);
    if (!locked) return LEASE_LOST;

    const { state: prev, ids } = await loadBoardState(client, board.id, locked.baselined_at?.toISOString() ?? null);
    const baseline = prev.baselinedAt === null;
    const jobsSeen = answer.kind === "snapshot" ? answer.jobs.length : null;
    const { now, followed, floorSec, random } = options;

    // A board's first answer is the baseline: every role on it is recorded as already open and never alerts. If that
    // answer is empty, it is far more likely to be a glitch than a company with no jobs, and baselining it would make
    // every real role look new on the next poll. So the board waits for an answer that lists something.
    if (answer.kind === "snapshot" && baseline && answer.jobs.length === 0) {
      const schedule = scheduleAfterSuccess({ currentSec: locked.poll_interval_sec, changed: false, followed, floorSec, strikes: "none", random });
      const nextPollAt = new Date(now.getTime() + schedule.delaySec * 1000);
      await finishBoard(client, board, {
        setEtag: false,
        etag: null,
        now,
        changed: false,
        baselinedAt: null,
        intervalSec: schedule.intervalSec,
        nextPollAt,
      });
      await recordPollRun(client, board, meta, {
        jobsSeen: 0,
        newCount: 0,
        closedCount: 0,
        error: null,
        note: "the first poll listed no roles; waiting for one that does before treating the board as seen",
      });
      await options.beforeCommit?.(client);
      return { ...LEASE_LOST, outcome: "held", jobsSeen: 0, intervalSec: schedule.intervalSec, nextPollAt };
    }

    const result = answer.kind === "snapshot" ? applySnapshot(prev, answer.jobs, now) : confirmPending(prev, now);
    const stored = await writeChanges(client, board, {
      plan: planWrites(prev, result.state),
      records: eventRecords(result, prev),
      ids,
      at: now,
      baseline,
    });

    const counts = noEvents();
    for (const event of stored) counts[event.type]++;
    const changed = baseline || stored.length > 0;
    const schedule = scheduleAfterSuccess({
      currentSec: locked.poll_interval_sec,
      changed,
      followed,
      floorSec,
      strikes: strikesOf(result),
      random,
    });
    const nextPollAt = new Date(now.getTime() + schedule.delaySec * 1000);

    await finishBoard(client, board, {
      setEtag: answer.kind === "snapshot",
      etag: answer.kind === "snapshot" ? answer.etag : null,
      now,
      changed,
      baselinedAt: result.state.baselinedAt,
      intervalSec: schedule.intervalSec,
      nextPollAt,
    });
    await recordPollRun(client, board, meta, {
      jobsSeen,
      newCount: counts.appeared + counts.reposted,
      closedCount: counts.closed,
      error: null,
      note: result.suspicious
        ? `${result.suspicious.missing} of ${result.suspicious.open} open roles vanished at once; closing waits for three checks over 20 minutes`
        : null,
    });
    await options.beforeCommit?.(client);

    return {
      outcome: "applied",
      baseline,
      counts,
      jobsSeen,
      openRoles: result.state.jobs.filter((job) => job.status === "open").length,
      onStrike: result.onStrike.length,
      suspicious: result.suspicious,
      intervalSec: schedule.intervalSec,
      nextPollAt,
    };
  });
}

/** Records a good answer on the board and gives the lease back. */
async function finishBoard(
  db: Queryable,
  board: ClaimedBoard,
  fields: {
    setEtag: boolean;
    etag: string | null;
    now: Date;
    changed: boolean;
    baselinedAt: string | null;
    intervalSec: number;
    nextPollAt: Date;
  },
): Promise<void> {
  const result = await db.query(
    `update board
        set etag = case when $3::boolean then $4::text else etag end,
            last_polled_at = $5::timestamptz,
            last_changed_at = case when $6::boolean then $5::timestamptz else last_changed_at end,
            baselined_at = $7::timestamptz,
            poll_interval_sec = $8,
            next_poll_at = $9::timestamptz,
            consecutive_failures = 0,
            consecutive_not_found = 0,
            last_error = null,
            claimed_until = null,
            claim_token = null
      where id = $1 and claim_token = $2`,
    [
      board.id,
      board.claimToken,
      fields.setEtag,
      fields.etag,
      fields.now.toISOString(),
      fields.changed,
      fields.baselinedAt,
      fields.intervalSec,
      fields.nextPollAt.toISOString(),
    ],
  );
  if (result.rowCount !== 1) throw new Error(`board ${board.id} was not updated: the lease is gone`);
}

export interface PollFailure {
  kind: "retry" | "error" | "invalid";
  reason: string;
  retryAfterSec: number | null;
}

export interface FailureResult {
  outcome: "recorded" | "lease-lost";
  failures: number;
  nextPollAt: Date | null;
  /** The board answered 404 often enough in a row that it has been switched off. Its roles were not touched. */
  deactivated: boolean;
}

/**
 * Finishes a poll that did not get a usable answer: a 429, a 5xx, a timeout, a 404, an answer that is not the shape the
 * adapter knows. Nothing about the board's roles changes, so a failed poll can never close anything. The board waits
 * longer each time it fails (see failureDelaySec) and the error is kept on the board and in poll_run.
 *
 * A 404 is special: it usually means the company has moved to another provider. It is counted separately, waits at least
 * half an hour before the next try, and after three in a row the board is switched off, with the reason written on it.
 */
export async function recordFailure(
  pool: Pool,
  board: ClaimedBoard,
  failure: PollFailure,
  meta: PollMeta,
  options: { now: Date; floorSec: number; random: number },
): Promise<FailureResult> {
  const message = oneLine(failure.kind === "invalid" ? `the feed changed shape: ${failure.reason}` : failure.reason);
  return withTransaction(pool, async (client) => {
    await limitTransaction(client);
    const { rows } = await client.query<{ consecutive_failures: number; poll_interval_sec: number; consecutive_not_found: number }>(
      "select consecutive_failures, poll_interval_sec, consecutive_not_found from board where id = $1 and claim_token = $2 for update",
      [board.id, board.claimToken],
    );
    const current = rows[0];
    if (!current) return { outcome: "lease-lost" as const, failures: 0, nextPollAt: null, deactivated: false };

    const failures = current.consecutive_failures + 1;
    const notFound = failure.kind === "error" && meta.status === 404;
    const notFoundInARow = notFound ? current.consecutive_not_found + 1 : 0;
    const gone = notFoundInARow >= NOT_FOUND_LIMIT;
    const delaySec = Math.max(
      failureDelaySec({
        failures,
        intervalSec: current.poll_interval_sec,
        retryAfterSec: failure.retryAfterSec,
        floorSec: options.floorSec,
        random: options.random,
      }),
      notFound ? NOT_FOUND_MIN_WAIT_SEC : 0,
    );
    const nextPollAt = new Date(options.now.getTime() + delaySec * 1000);
    await client.query(
      `update board
          set consecutive_failures = $3, last_error = $4, next_poll_at = $5::timestamptz,
              consecutive_not_found = $6,
              active = active and not $7::boolean,
              deactivated_at = case when $7::boolean then $8::timestamptz else deactivated_at end,
              deactivated_reason = case when $7::boolean then $9::text else deactivated_reason end,
              claimed_until = null, claim_token = null
        where id = $1 and claim_token = $2`,
      [
        board.id,
        board.claimToken,
        failures,
        message,
        nextPollAt.toISOString(),
        notFoundInARow,
        gone,
        options.now.toISOString(),
        GONE_REASON,
      ],
    );
    await recordPollRun(client, board, meta, {
      jobsSeen: null,
      newCount: 0,
      closedCount: 0,
      error: message,
      note: gone ? `switched off: ${GONE_REASON}` : null,
    });
    return { outcome: "recorded" as const, failures, nextPollAt, deactivated: gone };
  });
}

/** How many poll_run rows one clean-up pass deletes. */
const PRUNE_BATCH = 5000;

/** Deletes poll_run rows older than `keepDays`, in batches so no single statement runs long. Returns how many it deleted. */
export async function pruneOldPollRuns(db: Queryable, now: Date, keepDays = 7): Promise<number> {
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString();
  let total = 0;
  for (;;) {
    const result = await db.query(
      `delete from poll_run
        where id in (select id from poll_run where started_at < $1::timestamptz order by started_at limit $2)`,
      [cutoff, PRUNE_BATCH],
    );
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < PRUNE_BATCH) return total;
  }
}

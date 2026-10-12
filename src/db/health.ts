import type { HealthBoard, Metrics } from "../core/health.ts";
import { isProvider } from "../core/types.ts";
import type { Queryable } from "./pool.ts";

/** The numbers that say how the worker is doing, read from the database. What they mean is decided in src/core/health.ts. */

interface BoardRow {
  id: string;
  slug: string;
  name: string;
  provider: string;
  token: string;
  active: boolean;
  priority: boolean;
  next_poll_at: Date;
  poll_interval_sec: number;
  claimed_until: Date | null;
  last_polled_at: Date | null;
  last_changed_at: Date | null;
  baselined_at: Date | null;
  consecutive_failures: number;
  consecutive_not_found: number;
  last_error: string | null;
  deactivated_at: Date | null;
  deactivated_reason: string | null;
  open_roles: number;
  on_strike: number;
}

/** Every board with its company, its state and how many roles are open and waiting for a confirmation. */
export async function boardHealth(db: Queryable): Promise<HealthBoard[]> {
  const { rows } = await db.query<BoardRow>(
    `select b.id, c.slug, c.name, b.provider, b.token, b.active, b.priority, b.next_poll_at, b.poll_interval_sec,
            b.claimed_until, b.last_polled_at, b.last_changed_at, b.baselined_at, b.consecutive_failures,
            b.consecutive_not_found, b.last_error, b.deactivated_at, b.deactivated_reason,
            coalesce(p.open_roles, 0)::int as open_roles, coalesce(p.on_strike, 0)::int as on_strike
       from board b
       join company c on c.id = b.company_id
       left join (
              select board_id,
                     count(*) as open_roles,
                     count(*) filter (where missed_polls > 0) as on_strike
                from posting
               where status = 'open'
               group by board_id
            ) p on p.board_id = b.id
      order by c.name, b.provider, b.token`,
  );
  return rows.map((row): HealthBoard => {
    if (!isProvider(row.provider)) throw new Error(`board ${row.id} has an unknown provider: ${row.provider}`);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      provider: row.provider,
      token: row.token,
      active: row.active,
      priority: row.priority,
      nextPollAt: row.next_poll_at,
      pollIntervalSec: row.poll_interval_sec,
      claimedUntil: row.claimed_until,
      lastPolledAt: row.last_polled_at,
      lastChangedAt: row.last_changed_at,
      baselinedAt: row.baselined_at,
      consecutiveFailures: row.consecutive_failures,
      consecutiveNotFound: row.consecutive_not_found,
      lastError: row.last_error,
      deactivatedAt: row.deactivated_at,
      deactivatedReason: row.deactivated_reason,
      openRoles: row.open_roles,
      onStrike: row.on_strike,
    };
  });
}

/**
 * Queue lag: how many seconds overdue the most overdue board is, among the active boards that nobody is working on right
 * now. Healthy: under a minute. Over five minutes the worker is down, stuck or overloaded. This is the "Queue lag" tile on
 * the admin page.
 */
export async function queueLagSec(db: Queryable, now: Date): Promise<number> {
  const { rows } = await db.query<{ lag: number }>(
    `select coalesce(max(extract(epoch from ($1::timestamptz - next_poll_at))), 0)::int as lag
       from board
      where active
        and next_poll_at <= $1::timestamptz
        and (claimed_until is null or claimed_until <= $1::timestamptz)`,
    [now.toISOString()],
  );
  return Math.max(0, rows[0]?.lag ?? 0);
}

export interface PollCounts {
  polls: number;
  /** Polls that ended in an error. A 304 is not an error. */
  failed: number;
}

/** What happened to the polls in the last `windowSec` seconds (an hour by default). */
export async function pollCounts(db: Queryable, now: Date, windowSec = 3600): Promise<PollCounts> {
  const { rows } = await db.query<{ polls: number; failed: number }>(
    `select count(*)::int as polls, (count(*) filter (where error is not null))::int as failed
       from poll_run
      where started_at > $1::timestamptz - make_interval(secs => $2)`,
    [now.toISOString(), windowSec],
  );
  return { polls: rows[0]?.polls ?? 0, failed: rows[0]?.failed ?? 0 };
}

export interface LagReport {
  /** Polls in the window that have a lag recorded. */
  polls: number;
  /** How late the middle poll started, in milliseconds. Null when there are no polls. */
  medianMs: number | null;
  p95Ms: number | null;
  /** The worst. */
  maxMs: number | null;
  /** The share of the polls, from 0 to 1, that started less than a minute after falling due. */
  withinMinute: number | null;
}

/**
 * How late polls started over the last `windowSec` seconds, measured for every poll (poll_run.queue_lag_ms), so that "the
 * queue stays under a minute behind" can be shown over days and not only watched live. Polls recorded before the column
 * existed have no lag and are left out.
 */
export async function lagReport(db: Queryable, now: Date, windowSec: number): Promise<LagReport> {
  const { rows } = await db.query<{
    polls: number;
    median: number | null;
    p95: number | null;
    max: number | null;
    within_minute: number | null;
  }>(
    `select count(queue_lag_ms)::int as polls,
            round(percentile_cont(0.5) within group (order by queue_lag_ms))::float8 as median,
            round(percentile_cont(0.95) within group (order by queue_lag_ms))::float8 as p95,
            max(queue_lag_ms)::float8 as max,
            avg((queue_lag_ms < 60000)::int)::float8 as within_minute
       from poll_run
      where started_at > $1::timestamptz - make_interval(secs => $2)
        and queue_lag_ms is not null`,
    [now.toISOString(), windowSec],
  );
  const row = rows[0];
  return {
    polls: row?.polls ?? 0,
    medianMs: row?.median ?? null,
    p95Ms: row?.p95 ?? null,
    maxMs: row?.max ?? null,
    withinMinute: row?.within_minute ?? null,
  };
}

/** When the worker last finished a poll, or null if it never has. A worker that has gone quiet shows up here. */
export async function lastPollAt(db: Queryable): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>("select max(started_at) as at from poll_run");
  return rows[0]?.at ?? null;
}

/** Everything evaluateHealth needs, read at one moment. */
export async function collectMetrics(db: Queryable, now: Date): Promise<Metrics> {
  const [boards, lag, counts] = await Promise.all([boardHealth(db), queueLagSec(db, now), pollCounts(db, now)]);
  return { queueLagSec: lag, polls: counts.polls, failedPolls: counts.failed, boards };
}

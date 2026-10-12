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
 * now. Healthy: under a minute. Over five minutes the worker is down, stuck or overloaded. This is also what the health
 * endpoint reports as `workerLagSec`.
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

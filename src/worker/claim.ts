import { isProvider, type Provider } from "../core/types.ts";
import type { Queryable } from "../db/pool.ts";
import type { ClaimedBoard } from "./types.ts";

interface ClaimRow {
  id: string;
  company_id: string;
  company_slug: string;
  provider: string;
  token: string;
  etag: string | null;
  claim_token: string;
  poll_interval_sec: number;
  consecutive_failures: number;
  baselined_at: Date | null;
}

/**
 * Takes up to `limit` due boards of one provider and leases them until `now + leaseSec`.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets several workers pull from the same table without ever taking the same row: a
 * row another transaction is claiming is skipped, not waited for. The lock is held only for this one statement; after
 * it the lease (claimed_until and claim_token) is what keeps other workers away. If a worker dies mid-poll, its lease
 * runs out and the board is simply picked up again, so every step of a poll must be safe to repeat.
 *
 * The inner query is a materialised CTE on purpose. Written as `where id in (select ... for update skip locked limit n)`
 * the planner is free to run the subquery again for each row, which can claim more than `limit` boards.
 *
 * Times are passed in rather than read from the database, so the same code runs against a simulated clock in tests.
 */
export async function claimDueBoards(
  db: Queryable,
  args: { provider: Provider; limit: number; now: Date; leaseSec: number },
): Promise<ClaimedBoard[]> {
  if (args.limit <= 0) return [];
  const leaseUntil = new Date(args.now.getTime() + args.leaseSec * 1000);
  const { rows } = await db.query<ClaimRow>(
    `with picked as materialized (
       select id
         from board
        where active
          and provider = $1
          and next_poll_at <= $2::timestamptz
          and (claimed_until is null or claimed_until <= $2::timestamptz)
        order by next_poll_at, id
        limit $3
          for update skip locked
     ), claimed as (
       update board b
          set claimed_until = $4::timestamptz,
              claim_token = gen_random_uuid()
         from picked
        where b.id = picked.id
       returning b.*
     )
     select c.id, c.company_id, co.slug as company_slug, c.provider, c.token, c.etag, c.claim_token,
            c.poll_interval_sec, c.consecutive_failures, c.baselined_at
       from claimed c
       join company co on co.id = c.company_id
      order by c.next_poll_at, c.id`,
    [args.provider, args.now.toISOString(), args.limit, leaseUntil.toISOString()],
  );
  return rows.map(toClaimedBoard);
}

function toClaimedBoard(row: ClaimRow): ClaimedBoard {
  if (!isProvider(row.provider)) throw new Error(`board ${row.id} has an unknown provider: ${row.provider}`);
  return {
    id: row.id,
    companyId: row.company_id,
    companySlug: row.company_slug,
    provider: row.provider,
    token: row.token,
    etag: row.etag,
    claimToken: row.claim_token,
    pollIntervalSec: row.poll_interval_sec,
    consecutiveFailures: row.consecutive_failures,
    baselinedAt: row.baselined_at?.toISOString() ?? null,
  };
}

/**
 * The earliest moment a board of one of these providers could be claimed: when it falls due, or, for a board that is
 * leased, when the lease runs out (its holder may have crashed). Null when there is no such active board.
 */
export async function earliestClaimableAt(db: Queryable, providers: readonly Provider[]): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>(
    `select min(greatest(next_poll_at, coalesce(claimed_until, next_poll_at))) as at
       from board
      where active and provider = any($1::text[])`,
    [providers],
  );
  return rows[0]?.at ?? null;
}

/**
 * Gives leases back without recording a poll, for a worker that is shutting down. The boards stay due, so another
 * worker (or this one, after the restart) picks them up at once.
 */
export async function releaseLeases(db: Queryable, claimTokens: readonly string[]): Promise<number> {
  if (claimTokens.length === 0) return 0;
  const result = await db.query(
    "update board set claimed_until = null, claim_token = null where claim_token = any($1::uuid[])",
    [claimTokens],
  );
  return result.rowCount ?? 0;
}

import { PROVIDERS, type NormalizedJob, type Provider } from "../core/types.ts";
import type { Queryable } from "../db/pool.ts";
import { claimDueBoards } from "./claim.ts";
import type { FetchOutcome, Fetcher, GetOptions } from "./fetcher.ts";
import type { ClaimedBoard } from "./types.ts";

/** Helpers for the worker's database tests. */

/** The moment far enough in the future that every board is due and every lease has run out. */
export const FAR_FUTURE = new Date("2999-01-01T00:00:00Z");

/**
 * Leases one board directly, so a test about what happens during a poll does not also have to be about claiming. The
 * lease it takes runs to the year 2999 unless a test says otherwise.
 */
export async function leaseBoard(db: Queryable, boardId: string, now: Date = FAR_FUTURE, leaseSec = 60): Promise<ClaimedBoard> {
  for (const provider of PROVIDERS) {
    const claimed = await claimDueBoards(db, { provider, limit: 1000, now, leaseSec });
    const mine = claimed.find((board) => board.id === boardId);
    // Hand back the other boards this call happened to take: it is only meant to take one.
    const others = claimed.filter((board) => board.id !== boardId).map((board) => board.claimToken);
    if (others.length > 0) {
      await db.query("update board set claimed_until = null, claim_token = null where claim_token = any($1::uuid[])", [others]);
    }
    if (mine) return mine;
  }
  throw new Error(`board ${boardId} could not be leased: is it active and due?`);
}

export async function boardRow(db: Queryable, boardId: string) {
  const { rows } = await db.query<{
    etag: string | null;
    next_poll_at: Date;
    poll_interval_sec: number;
    claimed_until: Date | null;
    claim_token: string | null;
    last_polled_at: Date | null;
    last_changed_at: Date | null;
    baselined_at: Date | null;
    consecutive_failures: number;
    consecutive_not_found: number;
    last_error: string | null;
    active: boolean;
    priority: boolean;
    deactivated_at: Date | null;
    deactivated_reason: string | null;
  }>(
    `select etag, next_poll_at, poll_interval_sec, claimed_until, claim_token, last_polled_at, last_changed_at, baselined_at,
            consecutive_failures, consecutive_not_found, last_error, active, priority, deactivated_at, deactivated_reason
       from board where id = $1`,
    [boardId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no board ${boardId}`);
  return row;
}

export async function eventsOf(db: Queryable, boardId: string) {
  const { rows } = await db.query<{ type: string; external_id: string; detail: Record<string, unknown>; at: Date }>(
    `select e.type, p.external_id, e.detail, e.at
       from posting_event e join posting p on p.id = e.posting_id
      where p.board_id = $1
      order by e.id`,
    [boardId],
  );
  return rows;
}

export async function pollRuns(db: Queryable, boardId: string) {
  const { rows } = await db.query<{
    http_status: number | null;
    duration_ms: number | null;
    bytes: number | null;
    jobs_seen: number | null;
    new_count: number;
    closed_count: number;
    error: string | null;
    note: string | null;
  }>(
    "select http_status, duration_ms, bytes, jobs_seen, new_count, closed_count, error, note from poll_run where board_id = $1 order by id",
    [boardId],
  );
  return rows;
}

/** Which provider the factories' default board uses; tests that care pass their own. */
export const DEFAULT_PROVIDER: Provider = "greenhouse";

// ---- a fetcher that answers from a script, so a test needs no network ----

export interface FetchCall {
  url: string;
  options: GetOptions;
}

export interface ScriptedFetcher extends Fetcher {
  calls: FetchCall[];
}

/** A fetcher that answers from a function instead of the network. `calls` records every request it was asked for. */
export function scriptedFetcher(
  answer: (call: FetchCall, callNumber: number) => FetchOutcome | Promise<FetchOutcome>,
): ScriptedFetcher {
  const calls: FetchCall[] = [];
  return {
    calls,
    async get(url, options = {}) {
      const call = { url, options };
      calls.push(call);
      return answer(call, calls.length);
    },
  };
}

/** What an Ashby board answers with when it lists these roles. The adapter turns it back into the same roles. */
export function ashbyBody(roles: readonly NormalizedJob[]): string {
  return JSON.stringify({
    apiVersion: "1",
    jobs: roles.map((role) => ({
      id: role.externalId,
      title: role.title,
      jobUrl: role.url,
      isListed: true,
      publishedAt: role.postedAt,
      location: role.location,
      department: role.department,
      workplaceType: role.remote === true ? "Remote" : role.remote === false ? "OnSite" : null,
    })),
  });
}

export const okAnswer = (body: string, etag: string | null = 'W/"1"', ms = 40): FetchOutcome => ({
  kind: "ok",
  status: 200,
  ms,
  bytes: body.length,
  text: body,
  etag,
  cacheControl: null,
  contentEncoding: null,
});
export const notModifiedAnswer = (ms = 10): FetchOutcome => ({ kind: "unchanged", status: 304, ms, bytes: 0 });
export const retryAnswer = (reason: string, retryAfterSec: number | null = null, status: number | null = 503): FetchOutcome => ({
  kind: "retry",
  status,
  ms: 30,
  bytes: 0,
  reason,
  retryAfterSec,
});
export const errorAnswer = (reason: string, status: number | null = 404): FetchOutcome => ({ kind: "error", status, ms: 30, bytes: 0, reason });

/** A response from any provider that lists `count` roles with IDs `<prefix>1` ... `<prefix>N`. */
export function bodyFor(provider: Provider, count: number, prefix = "r"): string {
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  switch (provider) {
    case "greenhouse":
      return JSON.stringify({
        jobs: ids.map((n) => ({
          id: n,
          title: `Role ${prefix}${n}`,
          absolute_url: `https://example.test/jobs/${n}`,
          first_published: "2026-10-01T10:00:00Z",
          updated_at: "2026-10-02T10:00:00Z",
          location: { name: "Remote" },
        })),
        meta: { total: count },
      });
    case "lever":
      return JSON.stringify(
        ids.map((n) => ({
          id: `${prefix}${n}`,
          text: `Role ${prefix}${n}`,
          hostedUrl: `https://example.test/jobs/${n}`,
          createdAt: 1_790_000_000_000,
          workplaceType: "remote",
          categories: { location: "Remote" },
        })),
      );
    case "ashby":
      return JSON.stringify({
        apiVersion: "1",
        jobs: ids.map((n) => ({
          id: `${prefix}${n}`,
          title: `Role ${prefix}${n}`,
          jobUrl: `https://example.test/jobs/${n}`,
          isListed: true,
          publishedAt: "2026-10-01T10:00:00Z",
          location: "Remote",
          workplaceType: "Remote",
        })),
      });
  }
}

/**
 * Waits until `condition` is true, so a test waits for what it needs rather than sleeping a fixed time and hoping the
 * machine was fast enough. Fails with a clear message instead of hanging.
 */
export async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

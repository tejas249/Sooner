import type { Queryable } from "./pool.ts";

/**
 * What the owner can do to a board from the admin page. The kill switch for all polling is POLLING_ENABLED; these are the
 * switches for one board. Each is one small statement with its conditions in the WHERE clause, so a stale page (a board that
 * changed since it was drawn) cannot do the wrong thing.
 */

/** Written on a board paused by hand, so the health rules know it was a person's choice and not a fault. */
export const PAUSED_REASON = "paused from the admin page";

export type PollNowResult =
  /** The board is now due and the worker will take it within seconds. */
  | "queued"
  /** The board is switched off, so there is nothing to poll. Resume it first. */
  | "inactive"
  | "missing";

/**
 * Makes an active board due now. It does not poll in this call: the worker, which owns the politeness rules, takes it at its
 * next pass (at most 15 seconds). A board that was already due, or that a worker is polling right now, is left as it is.
 */
export async function pollBoardNow(db: Queryable, boardId: string, now: Date): Promise<PollNowResult> {
  const { rowCount } = await db.query(
    "update board set next_poll_at = least(next_poll_at, $2::timestamptz) where id = $1 and active",
    [boardId, now.toISOString()],
  );
  if (rowCount === 1) return "queued";
  const { rows } = await db.query("select 1 from board where id = $1", [boardId]);
  return rows.length === 0 ? "missing" : "inactive";
}

/** Switches an active board off by hand. Its roles are not touched. Returns false if it was not active. */
export async function pauseBoard(db: Queryable, boardId: string, now: Date): Promise<boolean> {
  const { rowCount } = await db.query(
    "update board set active = false, deactivated_at = $2::timestamptz, deactivated_reason = $3 where id = $1 and active",
    [boardId, now.toISOString(), PAUSED_REASON],
  );
  return rowCount === 1;
}

/**
 * Switches a board back on and makes it due now. A board that was switched off for answering 404 starts counting 404s again
 * from zero, so one more does not switch it straight off. Returns false if it was not switched off.
 */
export async function resumeBoard(db: Queryable, boardId: string, now: Date): Promise<boolean> {
  const { rowCount } = await db.query(
    `update board
        set active = true, deactivated_at = null, deactivated_reason = null, consecutive_not_found = 0,
            next_poll_at = least(next_poll_at, $2::timestamptz)
      where id = $1 and not active`,
    [boardId, now.toISOString()],
  );
  return rowCount === 1;
}

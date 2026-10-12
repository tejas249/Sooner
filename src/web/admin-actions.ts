import { pauseBoard, pollBoardNow, resumeBoard } from "../db/admin.ts";
import type { Queryable } from "../db/pool.ts";

/**
 * What a click on the admin page does, without anything specific to Next.js, so it can be tested on its own. The server
 * actions in app/admin/actions.ts check the password, call this, and redirect to the page with the outcome.
 */

export type BoardAction = "poll" | "pause" | "resume";

export type Outcome =
  | "queued"
  | "paused"
  | "resumed"
  /** The board was not in the state the action needs: the page was out of date. Nothing was changed. */
  | "unchanged"
  | "invalid"
  | "no-database";

/** Board IDs are database numbers. Anything else never reaches a query. */
const BOARD_ID = /^[0-9]{1,18}$/;

export const OUTCOME_TEXT: Record<Outcome, string> = {
  // 15 seconds is how long an idle worker waits at most before looking at the queue again (idleMaxMs in worker/loop.ts).
  queued: "Queued: the worker will poll it within about 15 seconds.",
  paused: "Switched off. Its roles were left as they are.",
  resumed: "Switched on and due now.",
  unchanged: "Nothing changed: the board was not in a state where that applies. The page may be out of date.",
  invalid: "That was not a valid board.",
  "no-database": "No database is configured.",
};

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === "string" && Object.hasOwn(OUTCOME_TEXT, value);
}

export async function performBoardAction(db: Queryable | null, action: BoardAction, rawId: unknown, now: Date): Promise<Outcome> {
  if (typeof rawId !== "string" || !BOARD_ID.test(rawId)) return "invalid";
  if (db === null) return "no-database";
  switch (action) {
    case "poll":
      return (await pollBoardNow(db, rawId, now)) === "queued" ? "queued" : "unchanged";
    case "pause":
      return (await pauseBoard(db, rawId, now)) ? "paused" : "unchanged";
    case "resume":
      return (await resumeBoard(db, rawId, now)) ? "resumed" : "unchanged";
  }
}

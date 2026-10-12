import { isSuspiciousDrop } from "./changes.ts";
import { DEGRADED_AFTER_FAILURES, NOT_FOUND_LIMIT } from "./schedule.ts";
import type { Provider } from "./types.ts";

/**
 * What a board looks like to whoever looks after the worker, and which problems are worth telling them about. Pure: the
 * database layer fetches the numbers, this decides what they mean, and the same decisions feed the worker's alerts, the
 * admin page and the health endpoint.
 */

export interface HealthBoard {
  id: string;
  slug: string;
  name: string;
  provider: Provider;
  token: string;
  active: boolean;
  priority: boolean;
  nextPollAt: Date;
  pollIntervalSec: number;
  claimedUntil: Date | null;
  lastPolledAt: Date | null;
  lastChangedAt: Date | null;
  baselinedAt: Date | null;
  consecutiveFailures: number;
  consecutiveNotFound: number;
  lastError: string | null;
  deactivatedAt: Date | null;
  deactivatedReason: string | null;
  openRoles: number;
  /** Open roles that were missing from the last answer and are waiting for their confirmation. */
  onStrike: number;
}

/** Written on a board that was switched off for answering 404. */
export const GONE_REASON =
  `the feed answered 404 ${NOT_FOUND_LIMIT} times in a row, at least half an hour apart, so the company has probably moved to ` +
  "another job-board provider. Its roles were left as they were.";

/** What the worker writes on a board whose answer was not the shape its adapter knows (see settle.ts). */
export const FORMAT_ERROR_PREFIX = "the feed changed shape";

export type BoardState =
  /** Polled, answering. */
  | "ok"
  /** Active but not baselined yet: no answer that listed a role has arrived. */
  | "waiting"
  /** The last poll or polls failed. It backs off and tries again. */
  | "failing"
  /** Eight or more failures in a row: tried once every six hours. */
  | "degraded"
  /** The answer is no longer the shape its adapter knows. Needs a human. */
  | "format-changed"
  /** Switched off after answering 404. */
  | "gone"
  /** Switched off by hand: paused or opted out. */
  | "paused";

export function boardState(board: HealthBoard): BoardState {
  if (!board.active) return board.deactivatedReason === GONE_REASON ? "gone" : "paused";
  if (board.lastError?.startsWith(FORMAT_ERROR_PREFIX)) return "format-changed";
  if (board.consecutiveFailures >= DEGRADED_AFTER_FAILURES) return "degraded";
  if (board.consecutiveFailures > 0) return "failing";
  if (board.baselinedAt === null) return "waiting";
  return "ok";
}

/** How far behind a board is, in seconds: 0 unless it is active, due and not being worked on right now. */
export function overdueSec(board: HealthBoard, now: Date): number {
  if (!board.active) return 0;
  if (board.claimedUntil !== null && board.claimedUntil.getTime() > now.getTime()) return 0;
  return Math.max(0, Math.floor((now.getTime() - board.nextPollAt.getTime()) / 1000));
}

/** Whether so many roles of the board vanished at once that closing them is held back. */
export function isHeldBack(board: Pick<HealthBoard, "openRoles" | "onStrike">): boolean {
  return isSuspiciousDrop(board.openRoles, board.onStrike);
}

export interface Thresholds {
  /** Queue lag over this many seconds is an alarm; it clears under `queueLagClearSec`. */
  queueLagAlarmSec: number;
  queueLagClearSec: number;
  /** Fewer than this share of polls succeeding (needs at least `successMinPolls` of them) is an alarm; it clears above the other. */
  successAlarmPct: number;
  successClearPct: number;
  successMinPolls: number;
  /** More than this share of active boards degraded is an alarm. */
  degradedShareAlarm: number;
  degradedShareClear: number;
}

export const THRESHOLDS: Thresholds = {
  queueLagAlarmSec: 300,
  queueLagClearSec: 120,
  successAlarmPct: 90,
  successClearPct: 95,
  successMinPolls: 20,
  degradedShareAlarm: 0.05,
  degradedShareClear: 0.02,
};

export type Severity = "warning" | "critical";

export interface Condition {
  /** Stable name of the problem, for example 'queue-lag' or 'board:17:gone'. One alert per key. */
  key: string;
  severity: Severity;
  title: string;
  detail: string;
}

/** One change in the state of one alert, to be told to the owner: it just opened, it is a reminder, or it was resolved. */
export type NoticeKind = "new" | "reminder" | "resolved";

export interface Notice extends Condition {
  kind: NoticeKind;
}

export interface Metrics {
  /** The most overdue board's lag in seconds. */
  queueLagSec: number;
  /** Poll runs in the last hour, and how many of them ended in an error. */
  polls: number;
  failedPolls: number;
  boards: readonly HealthBoard[];
}

/** "45 s", "5 min", "1 h 12 min". */
export function formatSeconds(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} s`;
  const minutes = Math.round(sec / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes - hours * 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "never", "just now", or "5 min ago". */
export function agoLabel(at: Date | null, now: Date): string {
  if (at === null) return "never";
  const sec = Math.max(0, (now.getTime() - at.getTime()) / 1000);
  return sec < 10 ? "just now" : `${formatSeconds(sec)} ago`;
}

/** When a board will be polled next, in words: "off", "polling now", "in 4 min", "due now" or "overdue 7 min". */
export function nextPollLabel(board: HealthBoard, now: Date): string {
  if (!board.active) return "off";
  if (board.claimedUntil !== null && board.claimedUntil.getTime() > now.getTime()) return "polling now";
  const sec = (board.nextPollAt.getTime() - now.getTime()) / 1000;
  if (sec > 0) return `in ${formatSeconds(sec)}`;
  return -sec < 60 ? "due now" : `overdue ${formatSeconds(-sec)}`;
}

const where = (board: HealthBoard): string => `${board.provider}:${board.token}`;

/**
 * The problems that exist right now. `open` holds the keys of alerts that are already open, which gives each global rule a
 * little hysteresis: a lag that hovers around the limit raises one alert and clears once, instead of flapping.
 */
export function evaluateHealth(metrics: Metrics, open: ReadonlySet<string> = new Set()): Condition[] {
  const t = THRESHOLDS;
  const conditions: Condition[] = [];

  const lagLimit = open.has("queue-lag") ? t.queueLagClearSec : t.queueLagAlarmSec;
  if (metrics.queueLagSec > lagLimit) {
    conditions.push({
      key: "queue-lag",
      severity: "critical",
      title: "Boards are being polled late",
      detail:
        `The most overdue board is ${formatSeconds(metrics.queueLagSec)} behind (healthy: under a minute). ` +
        "The worker may be down, stuck or overloaded: check its logs and the heartbeat.",
    });
  }

  if (metrics.polls >= t.successMinPolls) {
    const successPct = (100 * (metrics.polls - metrics.failedPolls)) / metrics.polls;
    const limit = open.has("poll-success") ? t.successClearPct : t.successAlarmPct;
    if (successPct < limit) {
      conditions.push({
        key: "poll-success",
        severity: "warning",
        title: "Many polls are failing",
        detail: `${metrics.failedPolls} of ${metrics.polls} polls in the last hour failed (${successPct.toFixed(1)}% succeeded; healthy: over 98%).`,
      });
    }
  }

  const active = metrics.boards.filter((b) => b.active);
  const degraded = active.filter((b) => b.consecutiveFailures >= DEGRADED_AFTER_FAILURES);
  const share = active.length === 0 ? 0 : degraded.length / active.length;
  const degradedLimit = open.has("degraded-boards") ? t.degradedShareClear : t.degradedShareAlarm;
  if (degraded.length > 0 && share > degradedLimit) {
    conditions.push({
      key: "degraded-boards",
      severity: "warning",
      title: "Many boards keep failing",
      detail:
        `${degraded.length} of ${active.length} active boards have failed ${DEGRADED_AFTER_FAILURES} or more times in a row ` +
        `(${degraded.slice(0, 5).map((b) => b.slug).join(", ")}${degraded.length > 5 ? ", ..." : ""}). They are tried once every six hours until they recover.`,
    });
  }

  for (const board of metrics.boards) {
    const state = boardState(board);
    if (state === "gone") {
      conditions.push({
        key: `board:${board.id}:gone`,
        severity: "warning",
        title: `${board.name} was switched off`,
        detail: `${where(board)}: ${board.deactivatedReason ?? GONE_REASON}`,
      });
    }
    if (state === "format-changed") {
      conditions.push({
        key: `board:${board.id}:format`,
        severity: "critical",
        title: `${board.name}: the feed changed shape`,
        detail: `${where(board)}: ${board.lastError ?? ""}. Nothing was changed for this board. The adapter needs a look.`,
      });
    }
    if (board.active && isHeldBack(board)) {
      conditions.push({
        key: `board:${board.id}:mass-drop`,
        severity: "warning",
        title: `${board.name}: ${board.onStrike} of ${board.openRoles} roles vanished at once`,
        detail:
          `${where(board)}: closing is held back until they have been missing on three checks over twenty minutes. ` +
          "Open the feed by hand and compare.",
      });
    }
  }
  return conditions;
}

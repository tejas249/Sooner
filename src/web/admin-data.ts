import { TARGETS, THRESHOLDS, agoLabel, formatSeconds, lagLabel, type Severity } from "../core/health.ts";
import { openAlerts, recentlyResolved, type AlertRow } from "../db/alerts.ts";
import { collectMetrics, lagReport, lastPollAt, pollCounts } from "../db/health.ts";
import type { Queryable } from "../db/pool.ts";
import { boardRows, type BoardRowView } from "./admin-view.ts";

/** What the admin page shows, read from the database in one go. The page does no queries of its own. */

export interface Tile {
  label: string;
  value: string;
  detail: string;
  /** True when this number is outside what is healthy. Shown as text as well as styling, never as colour alone. */
  attention: boolean;
}

export interface AlertView {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  /** "since 3 h ago" for an open alert, "resolved 2 h ago" for a closed one. */
  when: string;
  /** Whether the owner has been told, and when. */
  told: string;
}

export interface Overview {
  generatedAt: Date;
  tiles: Tile[];
  /** The same questions asked over two days, which is how long a worker has to keep its promises before they count. */
  lastTwoDays: Tile[];
  alerts: AlertView[];
  resolvedAlerts: AlertView[];
  boards: BoardRowView[];
}

function alertView(row: AlertRow, now: Date): AlertView {
  return {
    key: row.key,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    when: row.resolvedAt ? `resolved ${agoLabel(row.resolvedAt, now)}` : `since ${agoLabel(row.openedAt, now)}`,
    told: row.lastSentAt ? `last told ${agoLabel(row.lastSentAt, now)}` : "not told yet",
  };
}

const TWO_DAYS_SEC = 48 * 3600;

export async function loadOverview(db: Queryable, now: Date): Promise<Overview> {
  const [metrics, lastPoll, twoDays, lateness, openRows, resolvedRows, events] = await Promise.all([
    collectMetrics(db, now),
    lastPollAt(db),
    pollCounts(db, now, TWO_DAYS_SEC),
    lagReport(db, now, TWO_DAYS_SEC),
    openAlerts(db),
    recentlyResolved(db, 5),
    db.query<{ n: number }>(
      "select count(*)::int as n from posting_event where at > $1::timestamptz - interval '24 hours'",
      [now.toISOString()],
    ),
  ]);

  const boards = boardRows(metrics.boards, now);
  const active = metrics.boards.filter((b) => b.active).length;
  const attention = boards.filter((b) => b.attention).length;
  const openRoles = metrics.boards.reduce((sum, b) => sum + b.openRoles, 0);
  const successPct = metrics.polls === 0 ? null : (100 * (metrics.polls - metrics.failedPolls)) / metrics.polls;
  const sinceLastPollSec = lastPoll === null ? null : (now.getTime() - lastPoll.getTime()) / 1000;
  const t = THRESHOLDS;

  const tiles: Tile[] = [
    {
      label: "Worker",
      value: lastPoll === null ? "never polled" : `polled ${agoLabel(lastPoll, now)}`,
      detail: "the last poll to finish",
      // No poll for five minutes while boards exist means it is down or stuck (the priority boards alone are due every five).
      attention: active > 0 && (sinceLastPollSec === null || sinceLastPollSec > 300),
    },
    {
      label: "Queue lag",
      value: metrics.queueLagSec < 5 ? "none" : formatSeconds(metrics.queueLagSec),
      detail: "most overdue board; healthy is under a minute",
      attention: metrics.queueLagSec > t.queueLagAlarmSec,
    },
    {
      label: "Polls, last hour",
      value: successPct === null ? "none" : `${successPct.toFixed(1)}% ok`,
      detail: `${metrics.polls} polls, ${metrics.failedPolls} failed; healthy is over 98%`,
      attention: successPct !== null && metrics.polls >= t.successMinPolls && successPct < t.successAlarmPct,
    },
    {
      label: "Boards",
      value: `${active} on`,
      detail: `${metrics.boards.length - active} off · ${attention} need attention`,
      attention: attention > 0,
    },
    {
      label: "Roles",
      value: openRoles.toLocaleString("en-US"),
      detail: `${(events.rows[0]?.n ?? 0).toLocaleString("en-US")} changes in the last day`,
      attention: false,
    },
    {
      label: "Alerts",
      value: openRows.length === 0 ? "none open" : `${openRows.length} open`,
      detail: `${resolvedRows.length === 0 ? "none" : `${resolvedRows.length} lately`} resolved`,
      attention: openRows.length > 0,
    },
  ];

  const twoDaysPct = twoDays.polls === 0 ? null : (100 * (twoDays.polls - twoDays.failed)) / twoDays.polls;
  const lastTwoDays: Tile[] = [
    {
      label: "Polls, 48 hours",
      value: twoDays.polls === 0 ? "none" : twoDays.polls.toLocaleString("en-US"),
      detail:
        twoDaysPct === null
          ? "nothing to measure yet"
          : `${twoDaysPct.toFixed(1)}% succeeded, ${twoDays.failed.toLocaleString("en-US")} failed; healthy is over ${TARGETS.successPct}%`,
      attention: twoDaysPct !== null && twoDays.polls >= t.successMinPolls && twoDaysPct < TARGETS.successPct,
    },
    {
      label: "Queue lag, worst",
      value: lateness.maxMs === null ? "no data" : lagLabel(lateness.maxMs),
      detail: "the latest any poll started after its board fell due; healthy is under a minute",
      attention: lateness.maxMs !== null && lateness.maxMs >= TARGETS.queueLagSec * 1000,
    },
    {
      label: "Queue lag, typical",
      value: lateness.medianMs === null ? "no data" : lagLabel(lateness.medianMs),
      detail:
        lateness.withinMinute === null
          ? "written down with every poll from now on"
          : `median; 95th percentile ${lagLabel(lateness.p95Ms)}; ${(100 * lateness.withinMinute).toFixed(1)}% of polls started within a minute`,
      attention: false,
    },
  ];

  return {
    generatedAt: now,
    tiles,
    lastTwoDays,
    alerts: openRows.map((row) => alertView(row, now)),
    resolvedAlerts: resolvedRows.map((row) => alertView(row, now)),
    boards,
  };
}

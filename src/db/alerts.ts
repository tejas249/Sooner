import type { Condition, Notice, Severity } from "../core/health.ts";
import { withTransaction, type Pool, type Queryable } from "./pool.ts";

/**
 * Which alerts are open, kept in the database so that a problem is reported once, reminded now and then while it lasts,
 * and reported as resolved, and so that restarting the worker does not repeat all of them. What a problem *is* is decided
 * in src/core/health.ts; delivering a message is src/worker/notify.ts. This is the memory in between.
 */

export interface AlertRow {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  openedAt: Date;
  lastSentAt: Date | null;
  sendCount: number;
  resolvedAt: Date | null;
}

interface AlertDbRow {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  opened_at: Date;
  last_sent_at: Date | null;
  send_count: number;
  resolved_at: Date | null;
}

const toRow = (row: AlertDbRow): AlertRow => ({
  key: row.key,
  severity: row.severity,
  title: row.title,
  detail: row.detail,
  openedAt: row.opened_at,
  lastSentAt: row.last_sent_at,
  sendCount: row.send_count,
  resolvedAt: row.resolved_at,
});

/** The alerts that are open now, oldest first. */
export async function openAlerts(db: Queryable): Promise<AlertRow[]> {
  const { rows } = await db.query<AlertDbRow>(
    `select key, severity, title, detail, opened_at, last_sent_at, send_count, resolved_at
       from alert_state where resolved_at is null order by opened_at, key`,
  );
  return rows.map(toRow);
}

/** The most recently resolved alerts, newest first, for the admin page. */
export async function recentlyResolved(db: Queryable, limit = 10): Promise<AlertRow[]> {
  const { rows } = await db.query<AlertDbRow>(
    `select key, severity, title, detail, opened_at, last_sent_at, send_count, resolved_at
       from alert_state where resolved_at is not null order by resolved_at desc limit $1`,
    [limit],
  );
  return rows.map(toRow);
}

/** How long an alert that stays open waits before the owner is reminded, by severity. */
export interface ReminderEvery {
  critical: number;
  warning: number;
}
export const DEFAULT_REMINDER_EVERY_SEC: ReminderEvery = { critical: 3600, warning: 6 * 3600 };

export interface Reconciled {
  /** What the owner should be told, if a channel is configured: see reconcileAlerts. */
  notices: Notice[];
  /** Alerts that opened in this pass (a new problem), as opposed to ones merely offered again because nobody was told yet. */
  opened: string[];
  /** Alerts that were resolved in this pass. */
  resolved: string[];
}

/**
 * Brings the stored alerts in line with the problems that exist now, and returns what the owner should be told:
 *  - a problem with no open alert opens one (reopening a resolved one from scratch) and is a `new` notice;
 *  - a problem whose alert is open stays open, with its text brought up to date; it is a `new` notice if the owner has
 *    never been told (a send failed, or no channel was configured then), and a `reminder` once the reminder interval for its
 *    severity has passed since the owner was last told;
 *  - an open alert whose problem has gone is resolved, and is a `resolved` notice if the owner ever heard about it.
 *
 * Nothing here is marked as told. Call `markSent` after the notices were delivered: if delivery fails they are offered
 * again on the next pass.
 */
export async function reconcileAlerts(
  pool: Pool,
  conditions: readonly Condition[],
  now: Date,
  reminderEverySec: ReminderEvery = DEFAULT_REMINDER_EVERY_SEC,
): Promise<Reconciled> {
  return withTransaction(pool, async (client) => {
    // Two passes at once would each see "no open alert" and both open one. The key's primary key stops that too.
    await client.query("lock table alert_state in share row exclusive mode");
    const open = new Map((await openAlerts(client)).map((row) => [row.key, row]));
    const notices: Notice[] = [];
    const opened: string[] = [];
    const resolved: string[] = [];
    const at = now.toISOString();

    for (const condition of conditions) {
      const existing = open.get(condition.key);
      if (!existing) {
        await client.query(
          `insert into alert_state (key, severity, title, detail, opened_at)
           values ($1, $2, $3, $4, $5::timestamptz)
           on conflict (key) do update
              set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
                  opened_at = excluded.opened_at, last_sent_at = null, send_count = 0, resolved_at = null`,
          [condition.key, condition.severity, condition.title, condition.detail, at],
        );
        notices.push({ kind: "new", ...condition });
        opened.push(condition.key);
        continue;
      }
      if (existing.severity !== condition.severity || existing.title !== condition.title || existing.detail !== condition.detail) {
        await client.query("update alert_state set severity = $2, title = $3, detail = $4 where key = $1", [
          condition.key,
          condition.severity,
          condition.title,
          condition.detail,
        ]);
      }
      const never = existing.sendCount === 0 || existing.lastSentAt === null;
      const due = !never && now.getTime() - (existing.lastSentAt as Date).getTime() >= reminderEverySec[condition.severity] * 1000;
      if (never) notices.push({ kind: "new", ...condition });
      else if (due) notices.push({ kind: "reminder", ...condition });
    }

    const stillThere = new Set(conditions.map((c) => c.key));
    for (const row of open.values()) {
      if (stillThere.has(row.key)) continue;
      await client.query("update alert_state set resolved_at = $2::timestamptz where key = $1", [row.key, at]);
      resolved.push(row.key);
      if (row.sendCount > 0) notices.push({ kind: "resolved", key: row.key, severity: row.severity, title: row.title, detail: row.detail });
    }
    return { notices, opened, resolved };
  });
}

/** Records that the owner was told about these open alerts just now. Resolved notices need no record. */
export async function markSent(db: Queryable, notices: readonly Notice[], now: Date): Promise<void> {
  const keys = notices.filter((notice) => notice.kind !== "resolved").map((notice) => notice.key);
  if (keys.length === 0) return;
  await db.query(
    `update alert_state set last_sent_at = $2::timestamptz, send_count = send_count + 1
      where key = any($1::text[]) and resolved_at is null`,
    [keys, now.toISOString()],
  );
}

/** Deletes alerts that were resolved more than `keepDays` ago. */
export async function pruneResolvedAlerts(db: Queryable, now: Date, keepDays = 30): Promise<number> {
  const result = await db.query("delete from alert_state where resolved_at < $1::timestamptz", [
    new Date(now.getTime() - keepDays * 86_400_000).toISOString(),
  ]);
  return result.rowCount ?? 0;
}

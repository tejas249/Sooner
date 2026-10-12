import { evaluateHealth } from "../core/health.ts";
import { markSent, openAlerts, pruneResolvedAlerts, reconcileAlerts } from "../db/alerts.ts";
import { collectMetrics } from "../db/health.ts";
import type { Pool } from "../db/pool.ts";
import type { Logger } from "./log.ts";
import type { Notifier } from "./notify.ts";
import { Wakeup } from "./wakeup.ts";

export interface MonitorDeps {
  pool: Pool;
  /** Where alerts are delivered. Null means no channel is configured: alerts are still tracked and logged. */
  notifier: Notifier | null;
  log: Logger;
  now: () => Date;
}

export interface MonitorReport {
  /** Problems that exist right now. */
  problems: number;
  opened: string[];
  resolved: string[];
  /** Notices the owner was sent in this pass. */
  delivered: number;
  /** True when a channel is configured but the notices could not be delivered; they are offered again next pass. */
  deliveryFailed: boolean;
}

/**
 * One look at the whole system: read the numbers, decide which problems exist, bring the stored alerts in line, and tell the
 * owner about what changed. Reads the open alerts first because the rules need them (a problem that is already open
 * clears at a lower threshold than it opens at).
 */
export async function checkOnce(deps: MonitorDeps): Promise<MonitorReport> {
  const { pool, notifier, log } = deps;
  const now = deps.now();
  const open = await openAlerts(pool);
  const metrics = await collectMetrics(pool, now);
  const conditions = evaluateHealth(metrics, new Set(open.map((alert) => alert.key)));
  const { notices, opened, resolved } = await reconcileAlerts(pool, conditions, now);

  // Logged when it happens, not each time it is offered again because nobody could be told yet.
  for (const notice of notices) {
    if (notice.kind === "new" && opened.includes(notice.key)) {
      log[notice.severity === "critical" ? "error" : "warn"]("alert", { key: notice.key, severity: notice.severity, title: notice.title });
    } else if (notice.kind === "resolved") {
      log.info("alert resolved", { key: notice.key, title: notice.title });
    }
  }

  let delivered = 0;
  let deliveryFailed = false;
  if (notifier && notices.length > 0) {
    try {
      await notifier.send(notices);
      await markSent(pool, notices, now);
      delivered = notices.length;
    } catch (error) {
      deliveryFailed = true;
      log.warn("could not deliver alerts; they will be offered again", { channel: notifier.channel, error });
    }
  }
  return { problems: conditions.length, opened, resolved, delivered, deliveryFailed };
}

/**
 * Checks every `intervalMs` until `signal` fires. A pass that fails (the database was unreachable) is logged and the next
 * one tries again: the monitor must never be the thing that takes the worker down.
 */
export async function runMonitor(deps: MonitorDeps, signal: AbortSignal, intervalMs: number): Promise<void> {
  const wake = new Wakeup();
  let lastPrune = deps.now().getTime();
  while (!signal.aborted) {
    try {
      await checkOnce(deps);
      if (deps.now().getTime() - lastPrune >= 86_400_000) {
        lastPrune = deps.now().getTime();
        await pruneResolvedAlerts(deps.pool, deps.now());
      }
    } catch (error) {
      deps.log.error("the health check failed; trying again at the next interval", { error });
    }
    await wake.wait(intervalMs, signal);
  }
}

import type { Logger } from "./log.ts";
import { Wakeup } from "./wakeup.ts";

/**
 * The worker cannot tell you it is down. A heartbeat can: every minute it makes a request to an address at an outside
 * monitoring service (Healthchecks.io, Better Stack, Uptime Kuma and the like), and when the requests stop for a few
 * minutes, that service sends you a message.
 *
 * It must not be a liar, so the heartbeat is sent only while the worker loop has really completed a pass lately. A loop that
 * is stuck, or cannot reach the database, stops touching its liveness, the heartbeat goes quiet and the monitor notices.
 */

export interface Liveness {
  /** The loop calls this each time it completes a pass. */
  touch(): void;
  /** Milliseconds since the loop last completed a pass, or null if it has not yet. */
  idleMs(): number | null;
}

export function createLiveness(now: () => number = Date.now): Liveness {
  let last: number | null = null;
  return {
    touch: () => {
      last = now();
    },
    idleMs: () => (last === null ? null : now() - last),
  };
}

export interface HeartbeatOptions {
  /** The address to ping. A secret: it is never logged. */
  url: string;
  intervalMs: number;
  /** The loop counts as stuck when it has not completed a pass for this long. */
  staleAfterMs: number;
  liveness: Liveness;
  log: Logger;
  /** Only a test changes this. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** One ping. Returns true if the monitor answered 2xx. */
export async function ping(options: Pick<HeartbeatOptions, "url" | "fetchFn" | "timeoutMs">): Promise<boolean> {
  const doFetch = options.fetchFn ?? fetch;
  try {
    const response = await doFetch(options.url, {
      method: "GET",
      headers: { "user-agent": "Sooner-heartbeat/0.1" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Pings every `intervalMs` while the worker is healthy, until `signal` fires. A ping that fails is logged (without the
 * address) and the next interval tries again.
 */
export async function runHeartbeat(options: HeartbeatOptions, signal: AbortSignal): Promise<void> {
  const wake = new Wakeup();
  let stuck = false;
  let failing = false;
  while (!signal.aborted) {
    const idle = options.liveness.idleMs();
    if (idle === null || idle > options.staleAfterMs) {
      if (!stuck) {
        options.log.warn("not sending the heartbeat: the worker loop has not completed a pass lately", {
          idle_s: idle === null ? null : Math.round(idle / 1000),
        });
      }
      stuck = true;
    } else {
      stuck = false;
      const ok = await ping(options);
      if (!ok && !failing) options.log.warn("the heartbeat could not be delivered; will try again");
      if (ok && failing) options.log.info("the heartbeat is being delivered again");
      failing = !ok;
    }
    // While the loop is not healthy (starting up, or recovering), look again soon so the heartbeat resumes at once.
    await wake.wait(stuck ? Math.min(options.intervalMs, 2000) : options.intervalMs, signal);
  }
}

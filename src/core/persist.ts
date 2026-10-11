import type { ApplyResult, BoardState, JobEvent, TrackedJob } from "./changes.ts";
import type { Strikes } from "./schedule.ts";

/**
 * What to write after a poll. The change-detection reducer returns the whole new state of a board; this works out the
 * least that has to be written to turn the old rows into it, so a board of 800 roles where one title changed costs one
 * row update and one bulk timestamp update, not 800 rewrites.
 */

export interface WritePlan {
  /** Roles with no row yet. */
  inserts: TrackedJob[];
  /** Roles whose row changes: a field, the status, the miss count. */
  updates: TrackedJob[];
  /** Roles whose only change is that they were seen again. They are updated together in one statement. */
  touches: string[];
}

/** Everything about a role except when it was last seen. Every field is a string, number, boolean or null. */
function sameExceptLastSeen(a: TrackedJob, b: TrackedJob): boolean {
  return (Object.keys(b) as Array<keyof TrackedJob>).every((key) => key === "lastSeenAt" || a[key] === b[key]);
}

export function planWrites(prev: BoardState, next: BoardState): WritePlan {
  const before = new Map(prev.jobs.map((job) => [job.externalId, job]));
  const plan: WritePlan = { inserts: [], updates: [], touches: [] };
  for (const job of next.jobs) {
    const old = before.get(job.externalId);
    if (!old) plan.inserts.push(job);
    else if (!sameExceptLastSeen(old, job)) plan.updates.push(job);
    else if (old.lastSeenAt !== job.lastSeenAt) plan.touches.push(job.externalId);
  }
  return plan;
}

/** Every kind of event that is stored. The reducer produces the first four; `reposted` is an `appeared` that matched a closed role. */
export type EventType = JobEvent["type"] | "reposted";

/** One event, ready to be stored: which role, what happened and the evidence for it. */
export interface EventRecord {
  externalId: string;
  type: JobEvent["type"];
  detail: Record<string, unknown>;
}

/**
 * The events of one poll with the evidence the interface will need to explain them: the fields that changed, how many
 * days a role was open, how many misses it took, whether it closed under the stricter rule for a sudden mass
 * disappearance, and when a reopened role had closed.
 */
export function eventRecords(result: Pick<ApplyResult, "events" | "suspicious">, prev: BoardState): EventRecord[] {
  const before = new Map(prev.jobs.map((job) => [job.externalId, job]));
  return result.events.map((event): EventRecord => {
    const externalId = event.job.externalId;
    switch (event.type) {
      case "appeared":
        return { externalId, type: event.type, detail: {} };
      case "updated":
        return { externalId, type: event.type, detail: { changes: event.changes } };
      case "closed":
        return {
          externalId,
          type: event.type,
          detail: { openDays: event.openDays, strikes: event.strikes, suspicious: result.suspicious !== null },
        };
      case "reopened":
        return {
          externalId,
          type: event.type,
          detail: { reopenCount: event.job.reopenCount, closedAt: before.get(externalId)?.closedAt ?? null },
        };
    }
  });
}

/** Whether roles are still waiting for a confirmation after this poll, and how urgently. */
export function strikesOf(result: Pick<ApplyResult, "onStrike" | "suspicious">): Strikes {
  if (result.onStrike.length === 0) return "none";
  return result.suspicious ? "suspicious" : "pending";
}

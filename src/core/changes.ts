import { contentHash } from "./text.ts";
import type { NormalizedJob } from "./types.ts";

/**
 * Change detection for one board. Each successful poll is a full list of what is open right now; this module compares
 * it with what we believed before and says what changed. It is a pure function of (previous state, snapshot, clock):
 * no database, no network, no hidden time. The worker loads a board's rows, calls it, and writes the result back in one
 * transaction.
 *
 * The rules that keep it honest:
 *  - The first poll of a board is a baseline: everything is recorded, nothing is announced.
 *  - A role missing once is not closed. It is closed only after it is missing again at least two minutes later.
 *  - If many roles vanish at once, or the list comes back empty, three misses over 20 minutes are needed. A provider
 *    glitch must never read as "the company closed everything".
 *  - Nothing is ever deleted. Closed is a status.
 */

export interface TrackedJob extends NormalizedJob {
  /** Fingerprint of the fields we show, so an edit is a different hash for the same ID. */
  contentHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: "open" | "closed";
  closedAt: string | null;
  /** Polls in a row that did not list this role. 0 while it is listed. */
  missedPolls: number;
  /** When it first went missing. Null while it is listed. */
  missedSince: string | null;
  reopenCount: number;
  /** Already open when we first looked at the board. Never alerts; its age comes from the provider's date. */
  baseline: boolean;
}

export interface BoardState {
  /** Null until the first successful poll. */
  baselinedAt: string | null;
  jobs: TrackedJob[];
}

export const emptyBoardState = (): BoardState => ({ baselinedAt: null, jobs: [] });

export type FieldName = "title" | "location" | "department" | "remote" | "url";
export interface FieldChange {
  field: FieldName;
  from: string | boolean | null;
  to: string | boolean | null;
}

/** The job in each event is its state after the change. */
export type JobEvent =
  | { type: "appeared"; job: TrackedJob }
  | { type: "updated"; job: TrackedJob; changes: FieldChange[] }
  | { type: "closed"; job: TrackedJob; openDays: number; strikes: number }
  | { type: "reopened"; job: TrackedJob };

/** A role that was missing this time but is not closed yet. */
export interface OnStrike {
  job: TrackedJob;
  strikes: number;
  needed: number;
}

export interface ApplyResult {
  state: BoardState;
  /** Sorted by role ID so the same inputs always give the same output. */
  events: JobEvent[];
  onStrike: OnStrike[];
  /** Set when so many roles vanished at once that closing waits for more confirmations. A human should look. */
  suspicious: { open: number; missing: number } | null;
}

const NORMAL = { needed: 2, minGapMinutes: 2 };
const SUSPICIOUS = { needed: 3, minGapMinutes: 20 };
const SUSPICIOUS_SHARE = 0.4;
const SUSPICIOUS_MIN_OPEN = 5;

/**
 * Whether `missing` of `open` roles vanishing at once is too many to believe: all of them, or at least 40% of a board of at
 * least five. The same rule decides how many checks closing takes and when the owner is told, so it lives in one place.
 */
export function isSuspiciousDrop(open: number, missing: number): boolean {
  return open > 0 && (missing === open || (open >= SUSPICIOUS_MIN_OPEN && missing / open >= SUSPICIOUS_SHARE));
}

const FIELDS: readonly FieldName[] = ["title", "location", "department", "remote", "url"];

function track(job: NormalizedJob, at: string, baseline: boolean): TrackedJob {
  return {
    ...job,
    contentHash: contentHash(job),
    firstSeenAt: at,
    lastSeenAt: at,
    status: "open",
    closedAt: null,
    missedPolls: 0,
    missedSince: null,
    reopenCount: 0,
    baseline,
  };
}

/** The role is listed again: take the feed's current values and forget any misses. */
function refresh(row: TrackedJob, job: NormalizedJob, at: string): TrackedJob {
  return { ...row, ...job, contentHash: contentHash(job), lastSeenAt: at, missedPolls: 0, missedSince: null };
}

function diffFields(row: TrackedJob, job: NormalizedJob): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of FIELDS) {
    if (row[field] !== job[field]) changes.push({ field, from: row[field], to: job[field] });
  }
  return changes;
}

const DAY_MS = 86_400_000;

/** Days a role was open when it closed, counted from the provider's date when there is one. */
function openDays(row: TrackedJob, now: Date): number {
  const since = Date.parse(row.postedAt ?? row.firstSeenAt);
  return Math.max(0, Math.round((now.getTime() - since) / DAY_MS));
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byIdThenType = (a: JobEvent, b: JobEvent): number =>
  compareText(a.job.externalId, b.job.externalId) || compareText(a.type, b.type);

function toState(baselinedAt: string | null, rows: Map<string, TrackedJob>): BoardState {
  const jobs = [...rows.values()].sort((a, b) => compareText(a.externalId, b.externalId));
  return { baselinedAt, jobs };
}

/**
 * Give every missing role one more strike and close the ones that have earned it.
 * `openCount` is how many roles were open before this poll: that is the population that could have vanished, so new
 * arrivals in the same snapshot cannot dilute the ratio.
 */
function strikeMissing(
  working: Map<string, TrackedJob>,
  openCount: number,
  missing: readonly TrackedJob[],
  now: Date,
): Pick<ApplyResult, "events" | "onStrike" | "suspicious"> {
  const suspicious = isSuspiciousDrop(openCount, missing.length);
  const rule = suspicious ? SUSPICIOUS : NORMAL;
  const at = now.toISOString();
  const events: JobEvent[] = [];
  const onStrike: OnStrike[] = [];

  for (const row of missing) {
    const missedSince = row.missedSince ?? at;
    const strikes = row.missedPolls + 1;
    const waitedMinutes = (now.getTime() - Date.parse(missedSince)) / 60_000;
    if (strikes >= rule.needed && waitedMinutes >= rule.minGapMinutes) {
      const closed: TrackedJob = { ...row, status: "closed", closedAt: at, missedPolls: strikes, missedSince };
      working.set(row.externalId, closed);
      events.push({ type: "closed", job: closed, openDays: openDays(row, now), strikes });
    } else {
      const waiting: TrackedJob = { ...row, missedPolls: strikes, missedSince };
      working.set(row.externalId, waiting);
      onStrike.push({ job: waiting, strikes, needed: rule.needed });
    }
  }

  return {
    events,
    onStrike,
    suspicious: suspicious ? { open: openCount, missing: missing.length } : null,
  };
}

/** Apply one full, successfully parsed snapshot of a board. */
export function applySnapshot(prev: BoardState, jobs: readonly NormalizedJob[], now: Date): ApplyResult {
  const at = now.toISOString();
  const baseline = prev.baselinedAt === null;
  const known = new Map(prev.jobs.map((row) => [row.externalId, row]));
  const working = new Map(known);
  const seen = new Set<string>();
  const events: JobEvent[] = [];

  for (const job of jobs) {
    if (seen.has(job.externalId)) continue; // adapters reject repeated IDs; stay safe if one slips through
    seen.add(job.externalId);
    const row = known.get(job.externalId);

    if (!row) {
      const created = track(job, at, baseline);
      working.set(job.externalId, created);
      if (!baseline) events.push({ type: "appeared", job: created });
    } else if (row.status === "closed") {
      const reopened: TrackedJob = {
        ...refresh(row, job, at),
        status: "open",
        closedAt: null,
        reopenCount: row.reopenCount + 1,
      };
      working.set(job.externalId, reopened);
      events.push({ type: "reopened", job: reopened });
    } else {
      const changes = diffFields(row, job);
      const refreshed = refresh(row, job, at);
      working.set(job.externalId, refreshed);
      if (changes.length > 0) events.push({ type: "updated", job: refreshed, changes });
    }
  }

  const openBefore = prev.jobs.filter((row) => row.status === "open");
  const missing = openBefore.filter((row) => !seen.has(row.externalId));
  const struck = strikeMissing(working, openBefore.length, missing, now);
  events.push(...struck.events);

  return {
    state: toState(prev.baselinedAt ?? at, working),
    events: events.sort(byIdThenType),
    onStrike: struck.onStrike,
    suspicious: struck.suspicious,
  };
}

/**
 * The board answered 304: nothing changed since the snapshot that dropped some roles, so they are still missing. That
 * is their next strike, and it is how a quick confirmation works without downloading anything. With no roles on strike
 * a 304 changes nothing.
 */
export function confirmPending(prev: BoardState, now: Date): ApplyResult {
  const open = prev.jobs.filter((row) => row.status === "open");
  const missing = open.filter((row) => row.missedPolls > 0);
  if (missing.length === 0) return { state: prev, events: [], onStrike: [], suspicious: null };

  const working = new Map(prev.jobs.map((row) => [row.externalId, row]));
  const struck = strikeMissing(working, open.length, missing, now);
  return {
    state: toState(prev.baselinedAt, working),
    events: struck.events.sort(byIdThenType),
    onStrike: struck.onStrike,
    suspicious: struck.suspicious,
  };
}

/**
 * Seconds between the provider's date and the moment we first saw the role: how late we were. Null when the feed has
 * no date or the date is later than our clock (the provider's clock is off, which says nothing about us).
 */
export function detectionDelaySec(job: TrackedJob): number | null {
  if (job.postedAt === null) return null;
  const delay = (Date.parse(job.firstSeenAt) - Date.parse(job.postedAt)) / 1000;
  return delay >= 0 ? delay : null;
}

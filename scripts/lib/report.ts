import { detectionDelaySec, type ApplyResult, type FieldChange, type JobEvent, type TrackedJob } from "../../src/core/changes.ts";
import type { BoardEntry } from "./boards-file.ts";
import { bold, column, dim, formatAgo, formatBytes, formatCount, green, median, percentile, red, safe, truncate, yellow } from "./format.ts";

/** What happened to one board in one round. */
export interface BoardResult {
  board: BoardEntry;
  /** baseline = the first full poll of this board, downloaded = a changed list, unchanged = a 304. */
  kind: "baseline" | "downloaded" | "unchanged" | "failed";
  applied: ApplyResult | null;
  status: number | null;
  ms: number;
  bytes: number;
  reason: string | null;
  openRoles: number;
}

export interface RoundSummary {
  boards: number;
  baseline: number;
  downloaded: number;
  unchanged: number;
  failed: number;
  bytes: number;
  openRoles: number;
}

export function summarizeRound(results: readonly BoardResult[]): RoundSummary {
  const count = (kind: BoardResult["kind"]) => results.filter((r) => r.kind === kind).length;
  return {
    boards: results.length,
    baseline: count("baseline"),
    downloaded: count("downloaded"),
    unchanged: count("unchanged"),
    failed: count("failed"),
    bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    openRoles: results.reduce((sum, r) => sum + r.openRoles, 0),
  };
}

const show = (value: FieldChange["from"]): string =>
  value === null ? "none" : typeof value === "boolean" ? String(value) : `"${truncate(safe(value), 40)}"`;

const place = (job: TrackedJob): string => safe(job.location ?? "no place given");

function posted(job: TrackedJob, now: Date): string {
  return job.postedAt === null ? "no posting date" : `posted ${formatAgo(now.getTime() - Date.parse(job.postedAt))} ago`;
}

function roleLine(sign: string, name: string, job: TrackedJob, tail: string): string[] {
  return [
    `  ${sign} ${column(safe(name), 16)} ${column(safe(job.title), 52)} ${tail}`,
    dim(`      ${safe(job.url)}`),
  ];
}

/** The part of a round that people read: what is new, edited, closed or at risk. Empty when nothing changed. */
export function renderChanges(results: readonly BoardResult[], now: Date, maxPerGroup = 30): string[] {
  const groups: Record<"appeared" | "reopened" | "updated" | "closed" | "waiting" | "held", string[][]> = {
    appeared: [],
    reopened: [],
    updated: [],
    closed: [],
    waiting: [],
    held: [],
  };

  for (const result of results) {
    if (!result.applied) continue;
    const name = result.board.name;
    for (const event of result.applied.events) {
      switch (event.type) {
        case "appeared":
          groups.appeared.push(roleLine(green("+"), name, event.job, `${place(event.job)}  ${dim(posted(event.job, now))}`));
          break;
        case "reopened":
          groups.reopened.push(roleLine("^", name, event.job, place(event.job)));
          break;
        case "updated":
          groups.updated.push(roleLine(yellow("~"), name, event.job, event.changes.map((c) => `${c.field} ${show(c.from)} -> ${show(c.to)}`).join("; ")));
          break;
        case "closed":
          groups.closed.push(roleLine(red("-"), name, event.job, `closed after ${event.openDays} d open (missing on ${event.strikes} checks)`));
          break;
      }
    }
    for (const waiting of result.applied.onStrike) {
      groups.waiting.push(roleLine("?", name, waiting.job, `not listed (check ${waiting.strikes} of ${waiting.needed})`));
    }
    const s = result.applied.suspicious;
    if (s) {
      groups.held.push([`  ! ${safe(name)}: ${s.missing} of ${s.open} open roles vanished at once. Closing waits for 3 checks over 20 minutes.`]);
    }
  }

  const sections: Array<[keyof typeof groups, string]> = [
    ["appeared", "New roles"],
    ["updated", "Edited roles"],
    ["closed", "Closed roles"],
    ["reopened", "Reopened roles"],
    ["waiting", "Missing, waiting for a second check"],
    ["held", "Held back"],
  ];
  const lines: string[] = [];
  for (const [key, title] of sections) {
    const items = groups[key];
    if (items.length === 0) continue;
    lines.push("", bold(`${title} (${items.length})`));
    for (const item of items.slice(0, maxPerGroup)) lines.push(...item);
    if (items.length > maxPerGroup) lines.push(dim(`  ... and ${items.length - maxPerGroup} more`));
  }
  return lines;
}

/** Detection delay for new roles that carry a provider date: how long after the employer posted did we notice? */
export function renderDelays(events: readonly JobEvent[]): string[] {
  const delays = events.flatMap((e) => {
    if (e.type !== "appeared") return [];
    const d = detectionDelaySec(e.job);
    return d === null ? [] : [d / 60];
  });
  const appeared = events.filter((e) => e.type === "appeared").length;
  if (appeared === 0) return ["No new roles appeared during this run, so there is no detection delay to measure yet."];
  if (delays.length === 0) return [`${appeared} new roles appeared, but none carries a provider date to measure against.`];
  const mins = (m: number | null) => (m === null ? "n/a" : m < 1 ? `${Math.round(m * 60)} s` : `${m.toFixed(1)} min`);
  return [
    `Detection delay for ${delays.length} of ${appeared} new roles that carry a provider date:`,
    `  median ${mins(median(delays))} · 95th percentile ${mins(percentile(delays, 0.95))} · longest ${mins(Math.max(...delays))}`,
    dim("  (time between the employer's own date and the poll that first saw the role, so it includes up to one polling interval)"),
  ];
}

export function renderSummaryLine(summary: RoundSummary, elapsedMs: number): string {
  const parts = [
    summary.baseline > 0 ? `${summary.baseline} baselined` : null,
    `${summary.downloaded} downloaded`,
    `${summary.unchanged} unchanged (304)`,
    summary.failed > 0 ? red(`${summary.failed} failed`) : "0 failed",
  ].filter(Boolean);
  return `  ${summary.boards} boards in ${(elapsedMs / 1000).toFixed(1)} s: ${parts.join(" · ")} · ${formatBytes(summary.bytes)} read · ${formatCount(summary.openRoles)} open roles tracked`;
}

import { existsSync } from "node:fs";
import { z } from "zod";
import type { BoardState, TrackedJob } from "../../src/core/changes.ts";
import { readJson, writeJson } from "./json-file.ts";

// `satisfies` makes the compiler check these against the core types, so the saved file cannot drift from them.
const TrackedJobSchema = z.object({
  externalId: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  department: z.string().nullable(),
  remote: z.boolean().nullable(),
  url: z.string(),
  postedAt: z.string().nullable(),
  sourceUpdatedAt: z.string().nullable(),
  contentHash: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  status: z.enum(["open", "closed"]),
  closedAt: z.string().nullable(),
  missedPolls: z.number().int().nonnegative(),
  missedSince: z.string().nullable(),
  reopenCount: z.number().int().nonnegative(),
  baseline: z.boolean(),
}) satisfies z.ZodType<TrackedJob>;

const BoardStateSchema = z.object({
  baselinedAt: z.string().nullable(),
  jobs: z.array(TrackedJobSchema),
}) satisfies z.ZodType<BoardState>;

export const SavedBoard = z.object({
  /** The ETag of the last full answer, sent back as If-None-Match. */
  etag: z.string().nullable(),
  polledAt: z.string().nullable(),
  state: BoardStateSchema,
});
export type SavedBoard = z.infer<typeof SavedBoard>;

export const PollState = z.object({
  version: z.literal(1),
  /** Keyed by "provider:token". */
  boards: z.record(z.string(), SavedBoard),
});
export type PollState = z.infer<typeof PollState>;

export const emptyPollState = (): PollState => ({ version: 1, boards: {} });

/** The state saved by an earlier run, or an empty one when there is none yet. */
export function loadPollState(path: string): PollState {
  if (!existsSync(path)) return emptyPollState();
  return readJson(path, PollState, "the saved poll state (delete it, or run with --fresh, to start over)");
}

export function savePollState(path: string, state: PollState): void {
  writeJson(path, state);
}

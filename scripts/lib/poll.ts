import { applySnapshot, confirmPending, emptyBoardState } from "../../src/core/changes.ts";
import { fetchBoard } from "../../src/worker/fetch-board.ts";
import type { Fetcher } from "../../src/worker/fetcher.ts";
import type { BoardEntry } from "./boards-file.ts";
import type { BoardResult } from "./report.ts";
import type { SavedBoard } from "./state-file.ts";

/**
 * Polls one board once and applies the answer to what was saved for it.
 *
 * `next` is what to save afterwards, or null when nothing should change. A provider problem (a 429, a timeout, a 404, an
 * answer that is not the shape the adapter knows) comes back as `failed` with `next: null`: the saved roles and ETag stay
 * exactly as they were, so a failed poll can never close anything.
 */
export async function pollBoard(
  fetcher: Fetcher,
  board: BoardEntry,
  prior: SavedBoard | undefined,
  now: () => Date = () => new Date(),
): Promise<{ result: BoardResult; next: SavedBoard | null }> {
  const previous = prior?.state ?? emptyBoardState();
  const openBefore = previous.jobs.filter((job) => job.status === "open").length;
  const res = await fetchBoard(fetcher, { provider: board.provider, token: board.token, etag: prior?.etag });
  const at = now();
  const base = { board, status: res.status, ms: res.ms, bytes: res.bytes, reason: null, openRoles: openBefore };
  const openAfter = (jobs: typeof previous.jobs) => jobs.filter((job) => job.status === "open").length;

  switch (res.kind) {
    case "ok": {
      const applied = applySnapshot(previous, res.jobs, at);
      return {
        result: {
          ...base,
          kind: previous.baselinedAt === null ? "baseline" : "downloaded",
          applied,
          openRoles: openAfter(applied.state.jobs),
        },
        next: { etag: res.etag, polledAt: at.toISOString(), state: applied.state },
      };
    }
    case "unchanged": {
      // A 304 says the list is the same as the one that last dropped some roles, so those roles are still missing.
      const applied = confirmPending(previous, at);
      return {
        result: { ...base, kind: "unchanged", applied, openRoles: openAfter(applied.state.jobs) },
        next: { etag: prior?.etag ?? null, polledAt: at.toISOString(), state: applied.state },
      };
    }
    case "retry":
    case "error":
    case "invalid":
      return { result: { ...base, kind: "failed", applied: null, reason: res.reason }, next: null };
  }
}

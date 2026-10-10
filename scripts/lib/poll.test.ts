import { describe, expect, it } from "vitest";
import { minutes } from "../../src/core/test-utils.ts";
import type { FetchOutcome, Fetcher, GetOptions } from "../../src/worker/fetcher.ts";
import type { BoardEntry } from "./boards-file.ts";
import { pollBoard } from "./poll.ts";
import type { SavedBoard } from "./state-file.ts";

const board: BoardEntry = {
  slug: "acme",
  name: "Acme",
  segment: "global",
  provider: "greenhouse",
  token: "acme",
  rolesWhenConfirmed: 3,
  confirmedVia: "hint",
};

/** A Greenhouse answer with these role IDs. */
const greenhouse = (...ids: number[]): string =>
  JSON.stringify({
    jobs: ids.map((id) => ({
      id,
      title: `Role ${id}`,
      absolute_url: `https://acme.test/jobs/${id}`,
      first_published: "2026-10-08T10:00:00Z",
      location: { name: "Remote" },
    })),
    meta: { total: ids.length },
  });

const meta = { status: 200, ms: 10, bytes: 500 };
const ok = (text: string, etag = 'W/"e1"'): FetchOutcome => ({ kind: "ok", text, etag, cacheControl: null, contentEncoding: null, ...meta });
const unchanged: FetchOutcome = { kind: "unchanged", ...meta, status: 304, bytes: 0 };

/** Answers each request with the next scripted outcome, and remembers what it was asked. */
function script(...outcomes: FetchOutcome[]) {
  const asked: Array<GetOptions | undefined> = [];
  const queue = [...outcomes];
  const fetcher: Fetcher = {
    get(_url, options) {
      asked.push(options);
      const next = queue.shift();
      if (!next) throw new Error("the script ran out of answers");
      return Promise.resolve(next);
    },
  };
  return { fetcher, asked };
}

/** Runs polls in order, feeding each poll the state the previous one saved, as the script does between rounds. */
async function poll(fetcher: Fetcher, steps: Array<{ at: number }>) {
  let saved: SavedBoard | undefined;
  const results = [];
  for (const step of steps) {
    const { result, next } = await pollBoard(fetcher, board, saved, () => minutes(step.at));
    if (next) saved = next;
    results.push(result);
  }
  return { results, saved };
}

describe("pollBoard", () => {
  it("baselines a board the first time and announces nothing", async () => {
    const { fetcher } = script(ok(greenhouse(1, 2, 3)));
    const { results, saved } = await poll(fetcher, [{ at: 0 }]);
    expect(results[0]).toMatchObject({ kind: "baseline", openRoles: 3, status: 200 });
    expect(results[0]?.applied?.events).toEqual([]);
    expect(saved).toMatchObject({ etag: 'W/"e1"', polledAt: minutes(0).toISOString() });
  });

  it("sends the saved ETag on the next poll, and a 304 changes nothing", async () => {
    const { fetcher, asked } = script(ok(greenhouse(1, 2)), unchanged);
    const { results, saved } = await poll(fetcher, [{ at: 0 }, { at: 5 }]);
    expect(asked[0]?.etag).toBeUndefined();
    expect(asked[1]?.etag).toBe('W/"e1"');
    expect(results[1]).toMatchObject({ kind: "unchanged", openRoles: 2 });
    expect(results[1]?.applied?.events).toEqual([]);
    expect(saved?.etag).toBe('W/"e1"');
    expect(saved?.polledAt).toBe(minutes(5).toISOString());
  });

  it("reports a role that appeared, and saves the new ETag", async () => {
    const { fetcher } = script(ok(greenhouse(1, 2)), ok(greenhouse(1, 2, 3), 'W/"e2"'));
    const { results, saved } = await poll(fetcher, [{ at: 0 }, { at: 5 }]);
    expect(results[1]?.kind).toBe("downloaded");
    expect(results[1]?.applied?.events.map((e) => `${e.type}:${e.job.externalId}`)).toEqual(["appeared:3"]);
    expect(saved?.etag).toBe('W/"e2"');
  });

  it("counts a 304 as the second check, so a quick confirmation needs no download", async () => {
    // Role 3 disappears at minute 5 (check 1). A 304 at minute 7 says the list is unchanged: check 2, closed.
    const { fetcher } = script(ok(greenhouse(1, 2, 3)), ok(greenhouse(1, 2), 'W/"e2"'), unchanged);
    const { results } = await poll(fetcher, [{ at: 0 }, { at: 5 }, { at: 7 }]);
    expect(results[1]?.applied?.onStrike.map((s) => s.job.externalId)).toEqual(["3"]);
    expect(results[1]?.applied?.events).toEqual([]);
    expect(results[2]?.kind).toBe("unchanged");
    expect(results[2]?.applied?.events.map((e) => `${e.type}:${e.job.externalId}`)).toEqual(["closed:3"]);
    expect(results[2]?.openRoles).toBe(2);
  });

  it.each<[string, FetchOutcome]>([
    ["a 429", { kind: "retry", retryAfterSec: 30, reason: "HTTP 429", ...meta, status: 429 }],
    ["a server error", { kind: "retry", retryAfterSec: null, reason: "HTTP 503", ...meta, status: 503 }],
    ["a timeout", { kind: "retry", retryAfterSec: null, reason: "timeout", ...meta, status: null }],
    ["a 404", { kind: "error", reason: "HTTP 404", ...meta, status: 404 }],
    ["an answer that is not JSON", ok("<html>maintenance</html>")],
    ["JSON of the wrong shape", ok(JSON.stringify({ jobs: "nope" }))],
    ["a list shorter than the board's own total", ok(JSON.stringify({ jobs: [], meta: { total: 3 } }))],
  ])("leaves what was saved untouched after %s, so it can never close a role", async (_name, bad) => {
    const first = script(ok(greenhouse(1, 2, 3)));
    const { saved } = await poll(first.fetcher, [{ at: 0 }]);

    const second = script(bad);
    const outcome = await pollBoard(second.fetcher, board, saved, () => minutes(5));
    expect(outcome.next).toBeNull(); // the caller keeps the old state and ETag
    expect(outcome.result).toMatchObject({ kind: "failed", applied: null });
    expect(outcome.result.reason).toBeTruthy();
  });

  it("holds back a board that suddenly returns nothing instead of closing everything", async () => {
    const { fetcher } = script(ok(greenhouse(1, 2, 3)), ok(JSON.stringify({ jobs: [], meta: { total: 0 } }), 'W/"e2"'), unchanged, unchanged);
    const { results } = await poll(fetcher, [{ at: 0 }, { at: 5 }, { at: 10 }, { at: 15 }]);
    expect(results[1]?.applied?.suspicious).toEqual({ open: 3, missing: 3 });
    expect(results[1]?.applied?.events).toEqual([]);
    expect(results[2]?.applied?.events).toEqual([]); // two checks are not enough for a mass disappearance
    expect(results[3]?.applied?.events).toEqual([]); // and ten minutes is not twenty
  });

  it("starts a board that was never polled from nothing even when no ETag is saved", async () => {
    const { fetcher, asked } = script(ok(greenhouse(1)));
    await pollBoard(fetcher, board, undefined, () => minutes(0));
    expect(asked[0]?.etag).toBeUndefined();
  });
});

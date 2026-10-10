import { describe, expect, it } from "vitest";
import recorded from "../../fixtures/greenhouse/stripe.json" with { type: "json" };
import type { FetchOutcome, Fetcher, GetOptions } from "./fetcher.ts";
import { fetchBoard } from "./fetch-board.ts";

const meta = { status: 200, ms: 5, bytes: 100 };

/** A fetcher that returns one canned answer and remembers what it was asked. */
function cannedFetcher(outcome: FetchOutcome) {
  const calls: Array<{ url: string; options: GetOptions | undefined }> = [];
  const fetcher: Fetcher = {
    get(url, options) {
      calls.push({ url, options });
      return Promise.resolve(outcome);
    },
  };
  return { fetcher, calls };
}

const ok = (text: string): FetchOutcome => ({ kind: "ok", text, etag: 'W/"e1"', cacheControl: null, contentEncoding: "gzip", ...meta });

describe("fetchBoard", () => {
  it("asks the provider's own URL, sends the saved ETag, and returns parsed roles with the new ETag", async () => {
    const { fetcher, calls } = cannedFetcher(ok(JSON.stringify(recorded)));
    const out = await fetchBoard(fetcher, { provider: "greenhouse", token: "stripe", etag: 'W/"old"' });
    expect(calls).toEqual([
      { url: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs", options: { etag: 'W/"old"', timeoutMs: 30_000 } },
    ]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.jobs).toHaveLength(8);
      expect(out.etag).toBe('W/"e1"');
      expect(out).toMatchObject({ status: 200, ms: 5, bytes: 100, contentEncoding: "gzip" });
    }
  });

  it("allows a slow provider longer to answer: Lever took 52 seconds to build a 6 MB board", async () => {
    const { fetcher, calls } = cannedFetcher(ok("[]"));
    await fetchBoard(fetcher, { provider: "lever", token: "palantir" });
    expect(calls[0]?.options?.timeoutMs).toBe(120_000);
  });

  it("calls an answer that is not JSON a format change, never a list of zero roles", async () => {
    const { fetcher } = cannedFetcher(ok("<html>maintenance</html>"));
    expect(await fetchBoard(fetcher, { provider: "lever", token: "x" })).toMatchObject({
      kind: "invalid",
      reason: "lever: the answer is not JSON",
    });
  });

  it("calls JSON of the wrong shape a format change and names the provider", async () => {
    const { fetcher } = cannedFetcher(ok(JSON.stringify({ jobs: "nope" })));
    const out = await fetchBoard(fetcher, { provider: "ashby", token: "x" });
    expect(out.kind).toBe("invalid");
    expect(out.kind === "invalid" && out.reason).toMatch(/^ashby: unexpected response shape/);
  });

  it("passes unchanged, retry and error answers through untouched", async () => {
    for (const outcome of [
      { kind: "unchanged", ...meta, status: 304 },
      { kind: "retry", retryAfterSec: 30, reason: "HTTP 429", ...meta, status: 429 },
      { kind: "error", reason: "HTTP 404", ...meta, status: 404 },
    ] satisfies FetchOutcome[]) {
      const { fetcher } = cannedFetcher(outcome);
      expect(await fetchBoard(fetcher, { provider: "greenhouse", token: "x" })).toEqual(outcome);
    }
  });

  it("never builds a URL from a token that is not safe", async () => {
    const { fetcher, calls } = cannedFetcher(ok("[]"));
    await expect(fetchBoard(fetcher, { provider: "lever", token: "../../etc" })).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});

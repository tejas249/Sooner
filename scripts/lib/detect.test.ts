import { describe, expect, it } from "vitest";
import ramp from "../../fixtures/ashby/ramp.json" with { type: "json" };
import stripe from "../../fixtures/greenhouse/stripe.json" with { type: "json" };
import { adapters } from "../../src/core/adapters/index.ts";
import type { FetchOutcome, Fetcher } from "../../src/worker/fetcher.ts";
import type { Candidate } from "./boards-file.ts";
import { detect } from "./detect.ts";

const meta = { status: 200, ms: 1, bytes: 10 };
const ok = (body: unknown): FetchOutcome => ({ kind: "ok", text: JSON.stringify(body), etag: null, cacheControl: null, contentEncoding: null, ...meta });
const notFound: FetchOutcome = { kind: "error", reason: "HTTP 404", status: 404, ms: 1, bytes: 0 };
const unavailable: FetchOutcome = { kind: "retry", retryAfterSec: null, reason: "HTTP 503", status: 503, ms: 1, bytes: 0 };

const greenhouse = (token: string): string => adapters.greenhouse.url(token);
const lever = (token: string): string => adapters.lever.url(token);
const ashby = (token: string): string => adapters.ashby.url(token);

/** A fetcher that serves fixed answers by URL (404 for anything else) and remembers what it was asked. */
function fakeFetcher(answers: Record<string, FetchOutcome>) {
  const calls: string[] = [];
  const fetcher: Fetcher = {
    get(url) {
      calls.push(url);
      return Promise.resolve(answers[url] ?? notFound);
    },
  };
  return { fetcher, calls };
}

const candidate = (over: Partial<Candidate> = {}): Candidate => ({ name: "Stripe", segment: "global", website: "https://stripe.com", ...over });

describe("detect: the boards the list names", () => {
  it("believes a hint that the provider confirms, and reports the evidence for it", async () => {
    const { fetcher } = fakeFetcher({ [greenhouse("stripe")]: ok(stripe) });
    const result = await detect(fetcher, candidate({ boards: ["greenhouse:stripe"] }), true);
    expect(result).toMatchObject({ kind: "found", via: "hint", ref: { provider: "greenhouse", token: "stripe" }, roles: 8 });
    expect(result.kind === "found" && result.evidence.name).toBeGreaterThan(0);
  });

  it("still believes a hint whose board never mentions the company, but shows that it does not", async () => {
    const { fetcher } = fakeFetcher({ [greenhouse("acme")]: ok(stripe) });
    const result = await detect(fetcher, candidate({ name: "Acme Rockets", website: "https://acmerockets.example", boards: ["greenhouse:acme"] }), true);
    expect(result).toMatchObject({ kind: "found", via: "hint", evidence: { name: 0, domain: 0 } });
  });

  it("tries the listed boards in order and stops at the first that answers", async () => {
    const { fetcher, calls } = fakeFetcher({ [ashby("stripe")]: ok(ramp), [greenhouse("stripe")]: ok(stripe) });
    const result = await detect(fetcher, candidate({ name: "Ramp", website: "https://ramp.com", boards: ["lever:ramp", "ashby:stripe", "greenhouse:stripe"] }), true);
    expect(result).toMatchObject({ via: "hint", ref: { provider: "ashby", token: "stripe" } });
    expect(calls).toEqual([lever("ramp"), ashby("stripe")]);
  });

  it("ignores a hint that names a provider we cannot read", async () => {
    const { fetcher, calls } = fakeFetcher({});
    const result = await detect(fetcher, candidate({ boards: ["workday:stripe"] }), false);
    expect(result.kind).toBe("missing");
    expect(calls).toEqual([]);
  });
});

describe("detect: guesses", () => {
  it("guesses from the name and website, provider by provider, and takes the first board that answers", async () => {
    const { fetcher, calls } = fakeFetcher({ [lever("ramp")]: ok([]), [ashby("ramp")]: ok(ramp) });
    const result = await detect(fetcher, candidate({ name: "Ramp", website: "https://ramp.com" }), true);
    // The name run together is "ramp" and so is the website's first label, so one token is tried on each provider in turn.
    expect(calls).toEqual([greenhouse("ramp"), lever("ramp"), ashby("ramp")]);
    expect(result).toMatchObject({ kind: "found", via: "guess", ref: { provider: "ashby", token: "ramp" } });
  });

  it("accepts a guessed board that mentions the company", async () => {
    const { fetcher } = fakeFetcher({ [greenhouse("stripe")]: ok(stripe) });
    const result = await detect(fetcher, candidate(), true);
    expect(result).toMatchObject({ kind: "found", via: "guess", roles: 8 });
    expect(result.kind === "found" && result.evidence.name + result.evidence.domain).toBeGreaterThan(0);
  });

  it("ignores a guessed board that never mentions the company, and says so", async () => {
    // Another company's board under the token we guessed: here, Stripe's answer under "acmerockets".
    const { fetcher } = fakeFetcher({ [greenhouse("acmerockets")]: ok(stripe) });
    const result = await detect(fetcher, candidate({ name: "Acme Rockets", website: "https://acmerockets.example" }), true);
    expect(result).toMatchObject({ kind: "missing" });
    expect(result.kind === "missing" && result.notes).toEqual(["greenhouse:acmerockets exists but never mentions Acme Rockets, so it was ignored"]);
  });

  it("keeps looking after ignoring one, because the right board may be on another provider", async () => {
    const { fetcher } = fakeFetcher({ [greenhouse("ramp")]: ok(stripe), [ashby("ramp")]: ok(ramp) });
    const result = await detect(fetcher, candidate({ name: "Ramp", website: "https://ramp.com" }), true);
    expect(result).toMatchObject({ kind: "found", ref: { provider: "ashby", token: "ramp" } });
  });

  it("ignores a guessed board with no roles: that is more likely the wrong company than a quiet one", async () => {
    const { fetcher } = fakeFetcher({ [greenhouse("stripe")]: ok({ jobs: [], meta: { total: 0 } }) });
    expect((await detect(fetcher, candidate(), true)).kind).toBe("missing");
  });

  it("does not guess at all when told not to", async () => {
    const { fetcher, calls } = fakeFetcher({ [greenhouse("stripe")]: ok(stripe) });
    expect((await detect(fetcher, candidate(), false)).kind).toBe("missing");
    expect(calls).toEqual([]);
  });

  it("does not ask for the same board twice when a guess repeats a hint", async () => {
    const { fetcher, calls } = fakeFetcher({});
    await detect(fetcher, candidate({ boards: ["greenhouse:stripe"] }), true);
    expect(calls.filter((url) => url === greenhouse("stripe"))).toHaveLength(1);
  });
});

describe("detect: when it cannot tell", () => {
  it("reports a board that could not be reached as unreachable, not as missing", async () => {
    const { fetcher } = fakeFetcher({ [greenhouse("stripe")]: unavailable });
    const result = await detect(fetcher, candidate(), true);
    expect(result).toMatchObject({ kind: "unreachable", reason: "greenhouse:stripe: HTTP 503" });
  });

  it("still finds the board on another provider when one is down", async () => {
    const { fetcher } = fakeFetcher({ [greenhouse("ramp")]: unavailable, [ashby("ramp")]: ok(ramp) });
    const result = await detect(fetcher, candidate({ name: "Ramp", website: "https://ramp.com" }), true);
    expect(result).toMatchObject({ kind: "found", ref: { provider: "ashby", token: "ramp" } });
  });

  it("lists everything it tried when nothing is found", async () => {
    const { fetcher } = fakeFetcher({});
    const result = await detect(fetcher, candidate({ name: "Urban Company", website: "https://urbancompany.com" }), true);
    expect(result.kind === "missing" && result.tried).toEqual([
      "greenhouse:urbancompany",
      "lever:urbancompany",
      "ashby:urbancompany",
      "greenhouse:urban-company",
      "lever:urban-company",
      "ashby:urban-company",
    ]);
  });
});

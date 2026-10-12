import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adapters as realAdapters } from "../core/adapters/index.ts";
import { PROVIDERS, type NormalizedJob, type Provider } from "../core/types.ts";
import { createFetcher } from "./fetcher.ts";
import { fetchBoard } from "./fetch-board.ts";
import { HostGate } from "./gate.ts";
import { mockRoles, providerBody, startMockProviders, type MockProviders } from "./mock-boards.ts";

const UA = "TestBot/1.0 (+test@example.test)";
const fetcher = () => createFetcher({ userAgent: UA, gate: new HostGate({ gapMs: 0 }), timeoutMs: 1000 });

describe("providerBody", () => {
  const rich: Record<Provider, NormalizedJob[]> = {
    greenhouse: [
      { externalId: "8172510", title: "Abuse Investigator", location: "Seattle, New York City", department: null, remote: null, url: "https://example.test/a", postedAt: "2026-06-23T11:29:45.000Z", sourceUpdatedAt: "2026-06-24T01:00:00.000Z" },
      { externalId: "8172511", title: "Staff Engineer", location: "Remote - US", department: null, remote: true, url: "https://example.test/b", postedAt: null, sourceUpdatedAt: null },
      { externalId: "8172512", title: "Designer", location: null, department: null, remote: null, url: "https://example.test/c", postedAt: "2026-01-01T00:00:00.000Z", sourceUpdatedAt: null },
    ],
    lever: [
      { externalId: "abc-1", title: "Backend Engineer", location: "Berlin", department: "Engineering", remote: false, url: "https://example.test/a", postedAt: "2026-06-23T11:29:45.805Z", sourceUpdatedAt: null },
      { externalId: "abc-2", title: "Account Manager", location: null, department: null, remote: true, url: "https://example.test/b", postedAt: null, sourceUpdatedAt: null },
      { externalId: "abc-3", title: "Analyst", location: "Paris", department: "Finance", remote: null, url: "https://example.test/c", postedAt: "2026-02-02T02:02:02.002Z", sourceUpdatedAt: null },
    ],
    ashby: [
      { externalId: "uuid-1", title: "Security Engineer", location: "New York, NY", department: "Engineering", remote: false, url: "https://example.test/a", postedAt: "2026-03-01T09:30:00.000Z", sourceUpdatedAt: null },
      { externalId: "uuid-2", title: "Recruiter", location: "Remote", department: null, remote: true, url: "https://example.test/b", postedAt: null, sourceUpdatedAt: null },
      { externalId: "uuid-3", title: "Lawyer", location: null, department: "Legal", remote: null, url: "https://example.test/c", postedAt: "2026-04-04T04:04:04.004Z", sourceUpdatedAt: null },
    ],
  };

  it.each(PROVIDERS)("%s: the real adapter reads the body back as exactly the roles it was built from", (provider) => {
    const body = providerBody(provider, rich[provider]);
    expect(realAdapters[provider].parse(JSON.parse(body))).toEqual(rich[provider]);
  });

  it.each(PROVIDERS)("%s: the generated roles survive the round trip, whatever their number", (provider) => {
    for (const count of [0, 1, 7, 120]) {
      const roles = mockRoles(provider, count);
      expect(realAdapters[provider].parse(JSON.parse(providerBody(provider, roles)))).toEqual(roles);
    }
  });

  it("refuses a role its provider's format cannot carry, instead of quietly serving something else", () => {
    const [role] = mockRoles("ashby", 1) as [NormalizedJob];
    expect(() => providerBody("greenhouse", [{ ...role, externalId: "abc" }])).toThrow(/a Greenhouse ID is a number/);
    expect(() => providerBody("greenhouse", [{ ...mockRoles("greenhouse", 1)[0]!, department: "Eng" }])).toThrow(/no department/);
    expect(() => providerBody("greenhouse", [{ ...mockRoles("greenhouse", 1)[0]!, location: "Berlin" }])).toThrow(/remote/);
    expect(() => providerBody("lever", [{ ...role, sourceUpdatedAt: "2026-01-01T00:00:00.000Z" }])).toThrow(/carries no last-edit date/);
  });
});

describe("the mock servers", () => {
  let mock: MockProviders;
  beforeAll(async () => {
    mock = await startMockProviders({ timeoutMs: 400 });
  });
  afterAll(async () => {
    await mock.stop();
  });

  const get = (provider: Provider, token: string, etag?: string) =>
    fetchBoard(fetcher(), { provider, token, etag }, { adapters: mock.adapters });

  it.each(PROVIDERS)("%s: serves a board in its real format, with an ETag, and the real adapter reads it", async (provider) => {
    const token = `serve-${provider}`;
    const roles = mockRoles(provider, 5);
    mock.board(provider, token).set(roles);
    const out = await get(provider, token);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.jobs).toEqual(roles);
      expect(out.etag).toMatch(/^W\/"[0-9a-f]{16}"$/);
    }
  });

  it.each(PROVIDERS)("%s: answers 304 to the ETag it gave, and a new ETag when the board changes", async (provider) => {
    const token = `etag-${provider}`;
    const board = mock.board(provider, token).set(mockRoles(provider, 3));
    const first = await get(provider, token);
    const etag = first.kind === "ok" ? first.etag : null;
    expect(etag).toBeTruthy();
    expect((await get(provider, token, etag ?? undefined)).kind).toBe("unchanged");

    board.set(mockRoles(provider, 4));
    const changed = await get(provider, token, etag ?? undefined);
    expect(changed.kind).toBe("ok");
    expect(changed.kind === "ok" && changed.etag).not.toBe(etag);
  });

  it("returns 404 for a board it was never told about", async () => {
    const out = await get("ashby", "nobody-here");
    expect(out).toMatchObject({ kind: "error", status: 404 });
  });

  it("records who asked, with what, and when", async () => {
    const token = "record-me";
    mock.board("greenhouse", token).set(mockRoles("greenhouse", 2));
    await get("greenhouse", token);
    await get("greenhouse", token, 'W/"something"');
    const mine = mock.requestsFor("greenhouse").filter((r) => r.token === token);
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ userAgent: UA, status: 200, ifNoneMatch: null, closedEarly: false });
    expect(mine[1]).toMatchObject({ ifNoneMatch: 'W/"something"', cacheControl: "max-age=0" });
    expect((mine[1]?.at ?? 0) - (mine[0]?.at ?? 0)).toBeGreaterThan(0);
  });

  describe("on purpose, it", () => {
    const reply = async (behavior: Parameters<ReturnType<MockProviders["board"]>["next"]>[0], provider: Provider = "ashby") => {
      const token = `misbehave-${Math.random().toString(36).slice(2, 8)}`;
      mock.board(provider, token).set(mockRoles(provider, 3)).next(behavior);
      return get(provider, token);
    };

    it("answers 429 with Retry-After", async () => {
      expect(await reply({ status: 429, headers: { "retry-after": "90" } })).toMatchObject({ kind: "retry", status: 429, retryAfterSec: 90 });
    });

    it("answers 500", async () => {
      expect(await reply({ status: 500 })).toMatchObject({ kind: "retry", status: 500 });
    });

    it("answers 404", async () => {
      expect(await reply({ status: 404 })).toMatchObject({ kind: "error", status: 404 });
    });

    it("answers with a redirect, which a provider feed never does", async () => {
      expect(await reply({ status: 301, headers: { location: "http://127.0.0.1:1/elsewhere" } })).toMatchObject({
        kind: "error",
        reason: expect.stringMatching(/unexpected redirect/) as string,
      });
    });

    it("sends something that is not JSON", async () => {
      expect(await reply({ body: "{not json" })).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/not JSON/) as string });
    });

    it("sends JSON of the wrong shape", async () => {
      expect(await reply({ body: "{}" })).toMatchObject({ kind: "invalid" });
    });

    it("cuts the body off halfway", async () => {
      expect(await reply({ truncate: true }, "greenhouse")).toMatchObject({ kind: "retry", status: null });
    });

    it("never answers, so the client gives up at its timeout", async () => {
      const startedAt = performance.now();
      expect(await reply({ hang: true })).toMatchObject({ kind: "retry", reason: "timeout" });
      expect(performance.now() - startedAt).toBeLessThan(2000);
    });

    it("answers slowly", async () => {
      const startedAt = performance.now();
      expect((await reply({ delayMs: 150 })).kind).toBe("ok");
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(140);
    });

    it("misbehaves only for as many requests as it was told to, then goes back to normal", async () => {
      const token = "flaky";
      mock.board("ashby", token).set(mockRoles("ashby", 2)).next({ status: 503 }, 2);
      expect((await get("ashby", token)).kind).toBe("retry");
      expect((await get("ashby", token)).kind).toBe("retry");
      expect((await get("ashby", token)).kind).toBe("ok");
    });

    it("misbehaves for ever when told to, until it is made normal again", async () => {
      const token = "broken";
      const board = mock.board("ashby", token).set(mockRoles("ashby", 2)).always({ status: 500 });
      for (let i = 0; i < 3; i++) expect((await get("ashby", token)).kind).toBe("retry");
      board.normal();
      expect((await get("ashby", token)).kind).toBe("ok");
    });
  });

  it("counts the requests that are open at the same moment", async () => {
    const token = "busy";
    mock.board("lever", token).set(mockRoles("lever", 1)).next({ delayMs: 100 }, 3);
    const before = mock.requestsFor("lever").length;
    await Promise.all([get("lever", token), get("lever", token), get("lever", token)]);
    const mine = mock.requestsFor("lever").slice(before);
    expect(Math.max(...mine.map((r) => r.concurrent))).toBe(3);
    expect(mock.maxConcurrent("lever")).toBeGreaterThanOrEqual(3);
  });

  it("measures the shortest gap between requests arriving at one provider", async () => {
    const token = "gaps";
    mock.board("ashby", token).set(mockRoles("ashby", 1));
    const mark = mock.requestsFor("ashby").length;
    await get("ashby", token);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await get("ashby", token);
    const gaps = mock.requestsFor("ashby").slice(mark).map((r) => r.at);
    expect(gaps).toHaveLength(2);
    expect(mock.minGapMs("ashby")).toBeLessThanOrEqual((gaps[1] ?? 0) - (gaps[0] ?? 0) + 0.001);
    expect(mock.minGapMs("nonexistent" as Provider)).toBe(Infinity);
  });
});

describe("compression and Lever's cache quirk", () => {
  it("compresses answers when asked to, and the fetcher reads them", async () => {
    const mock = await startMockProviders({ gzip: true });
    try {
      mock.board("greenhouse", "big").set(mockRoles("greenhouse", 200));
      const out = await fetchBoard(fetcher(), { provider: "greenhouse", token: "big" }, { adapters: mock.adapters });
      expect(out.kind === "ok" && out.jobs.length).toBe(200);
      expect(out.kind === "ok" && out.contentEncoding).toBe("gzip");
    } finally {
      await mock.stop();
    }
  });

  it("makes Lever ignore the ETag when the client says no-cache, like the real Lever, and not when it says max-age=0", async () => {
    const mock = await startMockProviders();
    try {
      mock.board("lever", "plaid").set(mockRoles("lever", 3));
      const first = await fetchBoard(fetcher(), { provider: "lever", token: "plaid" }, { adapters: mock.adapters });
      const etag = first.kind === "ok" ? first.etag : null;

      // What Node's fetch would send on its own: Cache-Control: no-cache. Lever answers with the whole list again.
      const naive = await fetch(mock.adapters.lever.url("plaid"), { headers: { "if-none-match": etag ?? "", "cache-control": "no-cache" } });
      expect(naive.status).toBe(200);
      await naive.body?.cancel();

      // What the fetcher sends: Cache-Control: max-age=0. Lever answers 304.
      const polite = await fetchBoard(fetcher(), { provider: "lever", token: "plaid", etag }, { adapters: mock.adapters });
      expect(polite.kind).toBe("unchanged");
    } finally {
      await mock.stop();
    }
  });
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFetcher, type Fetcher } from "./fetcher.ts";
import { HostGate } from "./gate.ts";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let base = "";
let handler: Handler = (_req, res) => res.end();
let arrivals: Array<{ at: number; url: string; headers: http.IncomingHttpHeaders }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    arrivals.push({ at: performance.now(), url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  arrivals = [];
  handler = (_req, res) => res.end();
});

const fetcher = (over: Partial<Parameters<typeof createFetcher>[0]> = {}): Fetcher =>
  createFetcher({
    userAgent: "TestBot/1.0 (+test@example.test)",
    gate: new HostGate({ gapMs: 0 }),
    timeoutMs: 1000,
    maxBytes: 5000,
    ...over,
  });

const json = (res: http.ServerResponse, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

describe("a normal answer", () => {
  it("returns the body, the ETag and the sizes, and tells the server who is asking", async () => {
    handler = (_req, res) => json(res, { jobs: [1, 2] }, { etag: 'W/"abc"', "cache-control": "public, max-age=60" });
    const out = await fetcher().get(`${base}/board`);
    expect(out).toMatchObject({ kind: "ok", status: 200, etag: 'W/"abc"', cacheControl: "public, max-age=60", text: '{"jobs":[1,2]}', bytes: 14 });
    expect(arrivals[0]?.headers["user-agent"]).toBe("TestBot/1.0 (+test@example.test)");
    expect(arrivals[0]?.headers["accept"]).toBe("application/json");
    expect(arrivals[0]?.headers["if-none-match"]).toBeUndefined();
  });

  it("decodes gzip and counts the decoded size", async () => {
    const body = JSON.stringify({ jobs: "x".repeat(1000) });
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(body));
    };
    const out = await fetcher().get(`${base}/gz`);
    expect(out).toMatchObject({ kind: "ok", text: body, bytes: body.length, contentEncoding: "gzip" });
  });
});

describe("asking whether anything changed", () => {
  it("sends If-None-Match and reports a 304 as unchanged", async () => {
    handler = (req, res) => {
      if (req.headers["if-none-match"] === 'W/"abc"') {
        res.writeHead(304).end();
      } else {
        json(res, {}, { etag: 'W/"abc"' });
      }
    };
    const f = fetcher();
    expect((await f.get(`${base}/b`)).kind).toBe("ok");
    const second = await f.get(`${base}/b`, { etag: 'W/"abc"' });
    expect(second).toMatchObject({ kind: "unchanged", status: 304, bytes: 0 });
    expect(arrivals[1]?.headers["if-none-match"]).toBe('W/"abc"');
  });

  it("asks 'is your copy current?' (max-age=0), never 'skip your cache' (no-cache), which makes Lever ignore the ETag", async () => {
    handler = (_req, res) => json(res, {}, { etag: 'W/"abc"' });
    const f = fetcher();
    await f.get(`${base}/b`);
    await f.get(`${base}/b`, { etag: 'W/"abc"' });
    expect(arrivals[0]?.headers["cache-control"]).toBeUndefined(); // a plain request asks for nothing special
    expect(arrivals[1]?.headers["cache-control"]).toBe("max-age=0");
    expect(arrivals[1]?.headers["pragma"]).toBeUndefined();
  });
});

describe("answers that mean try again later", () => {
  it("reports 429 with the wait the server asked for", async () => {
    handler = (_req, res) => res.writeHead(429, { "retry-after": "7" }).end("slow down");
    expect(await fetcher().get(`${base}/b`)).toMatchObject({ kind: "retry", status: 429, retryAfterSec: 7, reason: "HTTP 429" });
  });

  it("reports a 5xx without a wait when the server gave none", async () => {
    handler = (_req, res) => res.writeHead(503).end();
    expect(await fetcher().get(`${base}/b`)).toMatchObject({ kind: "retry", status: 503, retryAfterSec: null });
  });

  it("reports a timeout as retryable, and does not hang", async () => {
    handler = () => {
      // never answers
    };
    const started = performance.now();
    const out = await fetcher({ timeoutMs: 150 }).get(`${base}/b`);
    expect(out).toMatchObject({ kind: "retry", status: null, reason: "timeout" });
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("lets one request ask for more (or less) time than the fetcher's default", async () => {
    handler = (_req, res) => {
      setTimeout(() => json(res, { slow: true }), 300);
    };
    const f = fetcher({ timeoutMs: 100 });
    expect((await f.get(`${base}/b`)).kind).toBe("retry"); // too slow for the default
    expect(await f.get(`${base}/b`, { timeoutMs: 2000 })).toMatchObject({ kind: "ok", text: '{"slow":true}' });
  });

  it("reports a connection that cannot be made as retryable", async () => {
    const out = await fetcher().get("http://127.0.0.1:1/b");
    expect(out).toMatchObject({ kind: "retry", status: null });
    expect(out.kind === "retry" && out.reason).toMatch(/^network error/);
  });

  it("reports a body cut off halfway as retryable, not as a short list", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": "100", "content-type": "application/json" });
      res.write('{"jobs":[');
      setTimeout(() => res.destroy(), 20);
    };
    const out = await fetcher().get(`${base}/b`);
    expect(out.kind).toBe("retry");
  });
});

describe("answers that will not get better by asking again", () => {
  it("reports a 404 as an error with its status", async () => {
    handler = (_req, res) => res.writeHead(404).end("nope");
    expect(await fetcher().get(`${base}/b`)).toMatchObject({ kind: "error", status: 404, reason: "HTTP 404" });
  });

  it("refuses a body over the size limit and stops reading it", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(20_000));
    };
    expect(await fetcher({ maxBytes: 5000 }).get(`${base}/b`)).toMatchObject({
      kind: "error",
      status: 200,
      reason: "response larger than 5000 bytes",
    });
  });

  it("refuses a gzip bomb by its decoded size", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(gzipSync("0".repeat(2_000_000)));
    };
    const out = await fetcher({ maxBytes: 100_000 }).get(`${base}/b`);
    expect(out).toMatchObject({ kind: "error", reason: "response larger than 100000 bytes" });
  });

  it("refuses to fetch anything that is not https, except from this machine", async () => {
    const out = await fetcher().get("http://example.invalid/board");
    expect(out).toMatchObject({ kind: "error", status: null, reason: "refusing http: URL" });
    expect((await fetcher().get("file:///etc/passwd")).kind).toBe("error");
    expect((await fetcher().get("ftp://example.invalid/x")).kind).toBe("error");
  });
});

describe("redirects", () => {
  it("are reported as an error by default, because provider feeds do not redirect", async () => {
    handler = (_req, res) => res.writeHead(302, { location: "/elsewhere" }).end();
    const out = await fetcher().get(`${base}/b`);
    expect(out).toMatchObject({ kind: "error", status: 302, reason: "unexpected redirect (HTTP 302)" });
    expect(arrivals).toHaveLength(1);
  });

  it("are followed, up to the limit, when asked to", async () => {
    handler = (req, res) => {
      if (req.url === "/a") res.writeHead(301, { location: "/b" }).end();
      else if (req.url === "/b") res.writeHead(302, { location: "/c" }).end();
      else json(res, { at: req.url });
    };
    expect(await fetcher().get(`${base}/a`, { maxRedirects: 2 })).toMatchObject({ kind: "ok", text: '{"at":"/c"}' });
    arrivals = [];
    expect(await fetcher().get(`${base}/a`, { maxRedirects: 1 })).toMatchObject({ kind: "error", reason: "unexpected redirect (HTTP 302)" });
  });

  it("never follow a redirect to a scheme we refuse", async () => {
    handler = (_req, res) => res.writeHead(302, { location: "http://example.invalid/x" }).end();
    const out = await fetcher().get(`${base}/b`, { maxRedirects: 3 });
    expect(out).toMatchObject({ kind: "error", reason: "refusing http: URL" });
  });
});

describe("politeness", () => {
  it("times the request itself, not the wait for a turn at the gate", async () => {
    handler = (_req, res) => json(res, {});
    const f = fetcher({ gate: new HostGate({ gapMs: 250 }) });
    const outcomes = await Promise.all([f.get(`${base}/1`), f.get(`${base}/2`), f.get(`${base}/3`)]);
    // The third waited about half a second for its turn, but the server answered at once.
    for (const outcome of outcomes) expect(outcome.ms).toBeLessThan(200);
  });

  it("keeps the number of requests in flight to one host under the gate's cap, and frees the slot after every outcome", async () => {
    let running = 0;
    let peak = 0;
    handler = (req, res) => {
      running++;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running--;
        if (req.url === "/fail") res.writeHead(500).end();
        else if (req.url === "/big") res.end("x".repeat(20_000));
        else json(res, {});
      }, 60);
    };
    const f = fetcher({ gate: new HostGate({ gapMs: 0, maxInFlight: 2 }) });
    const paths = ["/a", "/fail", "/big", "/b", "/fail", "/c", "/big", "/d"];
    const outcomes = await Promise.all(paths.map((p) => f.get(`${base}${p}`)));
    expect(outcomes).toHaveLength(8); // all of them finished, so no slot was left held
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });

  it("spaces out requests to one host through the gate, even when asked all at once", async () => {
    handler = (_req, res) => json(res, {});
    const f = fetcher({ gate: new HostGate({ gapMs: 150 }) });
    await Promise.all([f.get(`${base}/1`), f.get(`${base}/2`), f.get(`${base}/3`)]);
    const gaps = arrivals.map((a) => a.at).sort((a, b) => a - b).map((t, i, all) => (i === 0 ? Infinity : t - (all[i - 1] ?? 0)));
    expect(gaps.slice(1).every((g) => g >= 120)).toBe(true);
  });
});

describe("cancelling", () => {
  it("stops a request that is in progress and says it was aborted, not that it timed out", async () => {
    handler = () => undefined; // never answers
    const stop = new AbortController();
    const pending = fetcher({ timeoutMs: 5000 }).get(`${base}/slow`, { signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const startedAt = performance.now();
    stop.abort();
    const out = await pending;
    expect(out).toMatchObject({ kind: "retry", reason: "aborted" });
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("sends nothing at all when it is cancelled while waiting for its turn at the gate", async () => {
    handler = (_req, res) => setTimeout(() => json(res, {}), 150);
    const f = fetcher({ gate: new HostGate({ gapMs: 0, maxInFlight: 1 }) });
    const first = f.get(`${base}/first`);
    const stop = new AbortController();
    const queued = f.get(`${base}/queued`, { signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop.abort();
    await first;
    expect(await queued).toMatchObject({ kind: "retry", reason: "aborted" });
    expect(arrivals.map((a) => a.url)).toEqual(["/first"]);
  });

  it("frees the gate slot of a cancelled request", async () => {
    handler = (req, res) => (req.url === "/stuck" ? undefined : json(res, {}));
    const f = fetcher({ gate: new HostGate({ gapMs: 0, maxInFlight: 1 }) });
    const stop = new AbortController();
    const stuck = f.get(`${base}/stuck`, { signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop.abort();
    await stuck;
    expect((await f.get(`${base}/after`)).kind).toBe("ok");
  });

  it("still times out on its own when it is never cancelled", async () => {
    handler = () => undefined;
    const out = await fetcher({ timeoutMs: 80 }).get(`${base}/slow`, { signal: new AbortController().signal });
    expect(out).toMatchObject({ kind: "retry", reason: "timeout" });
  });
});

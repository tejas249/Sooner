import { describe, expect, it } from "vitest";
import { createLiveness, ping, runHeartbeat, type Liveness } from "./heartbeat.ts";
import { createMemoryLogger } from "./log.ts";
import { waitFor } from "./testing.ts";

describe("createLiveness", () => {
  it("has not seen the loop until it is touched, and then measures how long ago", () => {
    let clock = 1_000;
    const liveness = createLiveness(() => clock);
    expect(liveness.idleMs()).toBeNull();
    liveness.touch();
    clock = 4_500;
    expect(liveness.idleMs()).toBe(3_500);
    liveness.touch();
    expect(liveness.idleMs()).toBe(0);
  });
});

const SECRET = "https://hc.example.test/ping/7b1c-very-secret-uuid";

function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(answer());
  }) as typeof fetch;
  return { fn, calls };
}

describe("ping", () => {
  it("makes a GET request and reports whether the monitor answered 2xx", async () => {
    const ok = fakeFetch(() => new Response(null, { status: 200 }));
    expect(await ping({ url: SECRET, fetchFn: ok.fn })).toBe(true);
    expect(ok.calls[0]?.url).toBe(SECRET);
    expect(ok.calls[0]?.init.method).toBe("GET");
    expect(ok.calls[0]?.init.redirect).toBe("error");

    expect(await ping({ url: SECRET, fetchFn: fakeFetch(() => new Response(null, { status: 503 })).fn })).toBe(false);
  });

  it("reports a request that fails as not delivered instead of throwing", async () => {
    const broken = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    expect(await ping({ url: SECRET, fetchFn: broken })).toBe(false);
  });
});

describe("runHeartbeat", () => {
  function setup(answer: () => Response | Promise<Response> = () => new Response(null, { status: 200 })) {
    const net = fakeFetch(answer);
    const { logger, entries } = createMemoryLogger();
    let idle: number | null = null;
    const liveness: Liveness = { touch: () => (idle = 0), idleMs: () => idle };
    const stop = new AbortController();
    const run = () => runHeartbeat({ url: SECRET, intervalMs: 20, staleAfterMs: 1_000, liveness, log: logger, fetchFn: net.fn }, stop.signal);
    return { net, entries, stop, run, setIdle: (ms: number | null) => (idle = ms) };
  }

  it("sends nothing until the loop has completed a pass, and says so once", async () => {
    const { net, entries, stop, run } = setup();
    const running = run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop.abort();
    await running;
    expect(net.calls).toEqual([]);
    expect(entries.filter((e) => /not sending the heartbeat/.test(e.msg))).toHaveLength(1);
  });

  it("pings every interval while the loop is healthy", async () => {
    const { net, stop, run, setIdle } = setup();
    setIdle(0);
    const running = run();
    await waitFor(() => net.calls.length >= 3, "three pings");
    stop.abort();
    await running;
    expect(net.calls.every((c) => c.url === SECRET)).toBe(true);
  });

  it("goes quiet when the loop is stuck, so the monitor notices, and resumes when it recovers", async () => {
    const { net, entries, stop, run, setIdle } = setup();
    setIdle(0);
    const running = run();
    await waitFor(() => net.calls.length >= 1, "a ping");

    setIdle(5_000); // no pass completed for five seconds: stuck
    await new Promise((resolve) => setTimeout(resolve, 60));
    const whileStuck = net.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(net.calls.length).toBe(whileStuck);
    expect(entries.filter((e) => /not sending the heartbeat/.test(e.msg))).toHaveLength(1);

    setIdle(0);
    await waitFor(() => net.calls.length > whileStuck, "pings after recovery");
    stop.abort();
    await running;
  });

  it("logs a failing monitor once, not every interval, and says when it works again", async () => {
    let failing = true;
    const { net, entries, stop, run, setIdle } = setup(() => new Response(null, { status: failing ? 500 : 200 }));
    setIdle(0);
    const running = run();
    await waitFor(() => net.calls.length >= 4, "four pings");
    expect(entries.filter((e) => /could not be delivered/.test(e.msg))).toHaveLength(1);
    failing = false;
    await waitFor(() => entries.some((e) => /delivered again/.test(e.msg)), "the recovery message");
    stop.abort();
    await running;
  });

  it("never writes the address into the log", async () => {
    const { entries, stop, run, setIdle } = setup(() => new Response(null, { status: 500 }));
    setIdle(0);
    const running = run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop.abort();
    await running;
    expect(JSON.stringify(entries)).not.toContain("secret");
    expect(JSON.stringify(entries)).not.toContain("hc.example.test");
  });

  it("stops when told to, even in the middle of a long wait", async () => {
    const stop = new AbortController();
    const running = runHeartbeat(
      {
        url: SECRET,
        intervalMs: 60_000,
        staleAfterMs: 1_000,
        liveness: { touch: () => undefined, idleMs: () => 0 },
        log: createMemoryLogger().logger,
        fetchFn: fakeFetch(() => new Response(null)).fn,
      },
      stop.signal,
    );
    const startedAt = performance.now();
    setTimeout(() => stop.abort(), 30);
    await running;
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});

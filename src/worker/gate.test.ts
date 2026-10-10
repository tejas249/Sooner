import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostGate } from "./gate.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Sends one request per entry of `hosts` through the gate. Each holds its slot for `holdMs`, then lets go.
 * Resolves with the time (ms after the start) at which each request got through, sorted.
 */
async function through(gate: HostGate, hosts: string[], holdMs = 0, advanceMs = 60_000): Promise<number[]> {
  const origin = Date.now();
  const starts: number[] = [];
  const all = Promise.all(
    hosts.map(async (host) => {
      const release = await gate.acquire(host);
      starts.push(Date.now() - origin);
      if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
      release();
    }),
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  await all;
  return starts.sort((a, b) => a - b);
}

describe("HostGate, rate", () => {
  it("lets requests to one host start at most once per second, however many are waiting", async () => {
    const starts = await through(new HostGate(), ["a", "a", "a", "a"]);
    expect(starts).toEqual([0, 1000, 2000, 3000]);
  });

  it("never makes one host wait for another", async () => {
    const starts = await through(new HostGate(), ["a", "b", "c", "a"]);
    expect(starts).toEqual([0, 0, 0, 1000]);
  });

  it("does not hold a host back after a quiet spell", async () => {
    const gate = new HostGate();
    await through(gate, ["a"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await through(gate, ["a"])).toEqual([0]);
  });

  it("uses the gap it is given", async () => {
    const starts = await through(new HostGate({ gapMs: 250 }), ["a", "a", "a"]);
    expect(starts).toEqual([0, 250, 500]);
  });
});

describe("HostGate, requests in flight", () => {
  it("lets only `maxInFlight` requests to one host run at once, and starts the next as one finishes", async () => {
    // Three slow requests (5 s each) with a cap of 2: the third cannot start until the first one is done.
    const starts = await through(new HostGate({ gapMs: 0, maxInFlight: 2 }), ["a", "a", "a"], 5000);
    expect(starts).toEqual([0, 0, 5000]);
  });

  it("applies the cap to each host separately", async () => {
    const starts = await through(new HostGate({ gapMs: 0, maxInFlight: 1 }), ["a", "b", "a", "b"], 3000);
    expect(starts).toEqual([0, 0, 3000, 3000]);
  });

  it("serves waiting requests in the order they asked", async () => {
    const gate = new HostGate({ gapMs: 0, maxInFlight: 1 });
    const order: number[] = [];
    const all = Promise.all(
      [1, 2, 3, 4].map(async (n) => {
        const release = await gate.acquire("a");
        order.push(n);
        await new Promise((resolve) => setTimeout(resolve, 10));
        release();
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await all;
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("frees the slot only once, however many times the release is called", async () => {
    const gate = new HostGate({ gapMs: 0, maxInFlight: 1 });
    const release = await gate.acquire("a");
    release();
    release(); // a second call must not hand out a second slot
    const first = await gate.acquire("a");
    let secondGranted = false;
    void gate.acquire("a").then(() => {
      secondGranted = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(secondGranted).toBe(false);
    first();
    await vi.advanceTimersByTimeAsync(100);
    expect(secondGranted).toBe(true);
  });

  it("combines both limits: a held slot delays the start, and the gap still applies after it frees", async () => {
    const starts = await through(new HostGate({ gapMs: 1000, maxInFlight: 1 }), ["a", "a"], 400);
    // The second waits for the first to finish at 400 ms. The gap (1000 ms from the first start) then holds it to 1000.
    expect(starts).toEqual([0, 1000]);
  });
});

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

/**
 * A clock the test drives by hand, so a timer can fire late the way a real one does when the event loop is busy.
 * `jumpTo` moves time in one step and wakes every sleeper whose moment has passed, in order.
 */
function handClock() {
  let now = 0;
  const sleepers: Array<{ at: number; wake: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>((resolve) => sleepers.push({ at: now + ms, wake: resolve })),
    async jumpTo(to: number) {
      now = to;
      const due = sleepers.filter((sleeper) => sleeper.at <= to).sort((a, b) => a.at - b.at);
      for (const sleeper of due) sleepers.splice(sleepers.indexOf(sleeper), 1);
      for (const sleeper of due) sleeper.wake();
      for (let i = 0; i < 50; i++) await Promise.resolve(); // let the woken requests run on
    },
  };
}

describe("HostGate, timers that fire late", () => {
  it("keeps the gap from when a request really started, not from when it was meant to start", async () => {
    const clock = handClock();
    const gate = new HostGate({ gapMs: 1000, clock });
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      void gate.acquire("a").then((release) => {
        starts.push(clock.now());
        release();
      });
    }
    await clock.jumpTo(0);
    // The second request's timer is due at 1000 but only fires at 1050: the loop was busy. Then time runs on in small steps.
    await clock.jumpTo(990);
    await clock.jumpTo(1050);
    for (let t = 1060; t <= 5000; t += 10) await clock.jumpTo(t);

    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] as number) - (starts[i - 1] as number), `gap before request ${i + 1}`).toBeGreaterThanOrEqual(1000);
    }
  });

  it("does not stall a host for good when the clock is set back", async () => {
    const clock = handClock();
    const gate = new HostGate({ gapMs: 1000, clock });
    await clock.jumpTo(10_000);
    (await gate.acquire("a"))();
    let started = false;
    void gate.acquire("a").then(() => {
      started = true;
    });
    await clock.jumpTo(4_000); // the clock is set back six seconds (in real life it could be an hour) before the next request looks
    await clock.jumpTo(4_999);
    expect(started, "a full gap is still kept, counted from when the step was noticed").toBe(false);
    await clock.jumpTo(5_000);
    expect(started, "but not the six seconds that the old start time would have asked for").toBe(true);
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

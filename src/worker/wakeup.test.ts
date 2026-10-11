import { describe, expect, it } from "vitest";
import { Wakeup } from "./wakeup.ts";

const settled = async (promise: Promise<void>, ms: number): Promise<boolean> =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

describe("Wakeup", () => {
  it("waits for the time to pass", async () => {
    const wake = new Wakeup();
    const startedAt = performance.now();
    await wake.wait(60);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it("wakes at once when notified", async () => {
    const wake = new Wakeup();
    const waiting = wake.wait(10_000);
    setTimeout(() => wake.notify(), 20);
    expect(await settled(waiting, 500)).toBe(true);
  });

  it("remembers a notification that arrived while nobody was waiting", async () => {
    const wake = new Wakeup();
    wake.notify();
    expect(await settled(wake.wait(10_000), 500)).toBe(true);
    // ...once: the next wait really waits.
    expect(await settled(wake.wait(10_000), 80)).toBe(false);
  });

  it("wakes when the signal fires, and returns at once for a signal that has fired already", async () => {
    const wake = new Wakeup();
    const stop = new AbortController();
    const waiting = wake.wait(10_000, stop.signal);
    setTimeout(() => stop.abort(), 20);
    expect(await settled(waiting, 500)).toBe(true);
    expect(await settled(wake.wait(10_000, stop.signal), 100)).toBe(true);
  });

  it("does not leave the signal listening after it wakes", async () => {
    const wake = new Wakeup();
    const stop = new AbortController();
    await wake.wait(5, stop.signal);
    // Waiting again on the same signal works the same way: nothing was left over from the first wait.
    expect(await settled(wake.wait(10_000, stop.signal), 80)).toBe(false);
  });
});

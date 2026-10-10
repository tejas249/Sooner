import { describe, expect, it } from "vitest";
import { mapPool } from "./pool.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe("mapPool", () => {
  it("returns results in the order of the items, not the order they finish", async () => {
    const out = await mapPool([30, 1, 10], 3, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it("never has more than `concurrency` calls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it("copes with no items, and with a concurrency below one", async () => {
    expect(await mapPool([], 8, () => Promise.resolve(1))).toEqual([]);
    expect(await mapPool([1, 2], 0, (n) => Promise.resolve(n * 2))).toEqual([2, 4]);
  });

  it("passes a failure on to the caller", async () => {
    await expect(mapPool([1, 2, 3], 2, (n) => (n === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(n)))).rejects.toThrow("boom");
  });
});

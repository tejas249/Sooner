import { describe, expect, it } from "vitest";
import { defaultSpreadSec } from "./seed.ts";

describe("defaultSpreadSec", () => {
  it.each([
    [0, 60],
    [1, 60],
    [30, 60],
    [31, 62],
    [100, 200],
    [300, 600],
    [900, 1800],
    [5000, 1800],
  ])("%s new boards are spread over %s seconds: about two seconds each, never under a minute or over half an hour", (count, seconds) => {
    expect(defaultSpreadSec(count)).toBe(seconds);
  });
});

import { describe, expect, it } from "vitest";
import { column, formatAgo, formatBytes, formatCount, formatDuration, median, parseInterval, percentile, safe, truncate } from "./format.ts";

describe("formatAgo", () => {
  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [60_000, "1 min"],
    [59 * 60_000, "59 min"],
    [60 * 60_000, "1 h"],
    [47 * 3_600_000, "47 h"],
    [48 * 3_600_000, "2 d"],
    [400 * 86_400_000, "400 d"],
    [-5000, "just now"],
  ])("%d ms ago reads as %s", (ms, expected) => {
    expect(formatAgo(ms)).toBe(expected);
  });
});

describe("formatBytes and formatDuration", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1500, "1.5 KB"],
    [453_691, "454 KB"],
    [6_100_000, "6.1 MB"],
  ])("%d bytes read as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it.each([
    [850, "850 ms"],
    [14_200, "14.2 s"],
    [185_000, "3 m 05 s"],
  ])("%d ms reads as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("small helpers", () => {
  it("separates thousands", () => {
    expect(formatCount(14_212)).toBe("14,212");
  });

  it("cuts text with an ellipsis and pads columns", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(column("ab", 5)).toBe("ab   ");
    expect(column("abcdefgh", 5)).toBe("abcd…");
  });
});

describe("percentile and median", () => {
  it("interpolates between values", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48);
    expect(percentile([5], 0.95)).toBe(5);
  });

  it("is null for nothing", () => {
    expect(median([])).toBeNull();
  });

  it("does not depend on the order of the input", () => {
    expect(median([9, 1, 5])).toBe(5);
  });
});

describe("parseInterval", () => {
  it.each([
    ["90s", 90_000],
    ["5m", 300_000],
    ["2h", 7_200_000],
    ["45", 45_000],
    [" 1.5m ", 90_000],
  ])("reads %j as %d ms", (text, expected) => {
    expect(parseInterval(text)).toBe(expected);
  });

  it.each(["", "soon", "-5m", "5 minutes", "m5"])("rejects %j", (text) => {
    expect(() => parseInterval(text)).toThrow(/is not a duration/);
  });
});

describe("safe", () => {
  it("leaves ordinary text alone, including accents and other scripts", () => {
    expect(safe("Senior Engineer (Zürich) - エンジニア")).toBe("Senior Engineer (Zürich) - エンジニア");
  });

  it("replaces control characters, so an escape sequence in a job title cannot drive the terminal", () => {
    const esc = String.fromCharCode(0x1b);
    const bell = String.fromCharCode(0x07);
    const c1 = String.fromCharCode(0x9b);
    expect(safe(`Engineer${esc}[2J${bell}${c1}31m\nNext\tline`)).toBe("Engineer [2J  31m Next line");
    expect(safe(`a${esc}b`)).not.toContain(esc);
  });
});

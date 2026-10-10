import { describe, expect, it } from "vitest";
import { MAX_WAIT_SEC, parseRetryAfter } from "./schedule.ts";

const now = new Date("2026-10-21T07:00:00Z");

describe("parseRetryAfter", () => {
  it("reads whole seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
  });

  it("reads an HTTP date as the seconds until then", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:01:30 GMT", now)).toBe(90);
  });

  it("treats a date in the past as no wait", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2026 06:00:00 GMT", now)).toBe(0);
  });

  it("never asks us to wait longer than the longest wait we allow", () => {
    expect(parseRetryAfter("999999999", now)).toBe(MAX_WAIT_SEC);
    expect(parseRetryAfter("Thu, 31 Dec 2026 00:00:00 GMT", now)).toBe(MAX_WAIT_SEC);
  });

  it.each([null, undefined, "", "   ", "soon", "-5", "5.5", "1e3", "2026-10-21"])("returns null for %j", (value) => {
    expect(parseRetryAfter(value, now)).toBeNull();
  });
});

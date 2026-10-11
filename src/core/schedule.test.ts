import { describe, expect, it } from "vitest";
import { MAX_WAIT_SEC, adaptInterval, failureDelaySec, parseRetryAfter, scheduleAfterSuccess, withJitter } from "./schedule.ts";

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

describe("adaptInterval", () => {
  const base = { changed: false, followed: false, floorSec: 60 };

  it("keeps a followed board at five minutes however quiet it is", () => {
    for (const currentSec of [300, 1800, 21_600]) {
      expect(adaptInterval({ ...base, followed: true, currentSec })).toBe(300);
      expect(adaptInterval({ ...base, followed: true, changed: true, currentSec })).toBe(300);
    }
  });

  it("slows a quiet board by half again, up to six hours", () => {
    expect(adaptInterval({ ...base, currentSec: 1800 })).toBe(2700);
    expect(adaptInterval({ ...base, currentSec: 2700 })).toBe(4050);
    expect(adaptInterval({ ...base, currentSec: 20_000 })).toBe(MAX_WAIT_SEC);
    expect(adaptInterval({ ...base, currentSec: MAX_WAIT_SEC })).toBe(MAX_WAIT_SEC);
  });

  it("speeds a busy board up by half, but never below 30 minutes", () => {
    expect(adaptInterval({ ...base, changed: true, currentSec: 21_600 })).toBe(10_800);
    expect(adaptInterval({ ...base, changed: true, currentSec: 3600 })).toBe(1800);
    expect(adaptInterval({ ...base, changed: true, currentSec: 1800 })).toBe(1800);
  });

  it("never goes below the provider's own minimum", () => {
    expect(adaptInterval({ ...base, followed: true, floorSec: 600, currentSec: 300 })).toBe(600);
    expect(adaptInterval({ ...base, changed: true, floorSec: 7200, currentSec: 1800 })).toBe(7200);
  });
});

describe("withJitter", () => {
  it("moves a value by at most ten percent either way", () => {
    expect(withJitter(1000, 0)).toBe(900);
    expect(withJitter(1000, 0.5)).toBe(1000);
    expect(withJitter(1000, 0.999999)).toBe(1100);
  });

  it("respects the floor", () => {
    expect(withJitter(100, 0, 100)).toBe(100);
  });
});

describe("scheduleAfterSuccess", () => {
  const base = { currentSec: 1800, changed: false, followed: false, floorSec: 60, random: 0.5 };

  it("uses the board's own rhythm when nothing is waiting for a confirmation", () => {
    expect(scheduleAfterSuccess({ ...base, strikes: "none" })).toEqual({ intervalSec: 2700, delaySec: 2700 });
    expect(scheduleAfterSuccess({ ...base, followed: true, strikes: "none" })).toEqual({ intervalSec: 300, delaySec: 300 });
  });

  it("asks again in two minutes when a role is missing once, and in ten when so many vanished that three checks are needed", () => {
    expect(scheduleAfterSuccess({ ...base, strikes: "pending" }).delaySec).toBe(120);
    expect(scheduleAfterSuccess({ ...base, strikes: "suspicious" }).delaySec).toBe(600);
  });

  it("still remembers the board's interval while it waits for a confirmation", () => {
    expect(scheduleAfterSuccess({ ...base, followed: true, strikes: "pending" })).toEqual({ intervalSec: 300, delaySec: 120 });
  });

  it("does not ask a provider sooner than it allows, even for a confirmation", () => {
    expect(scheduleAfterSuccess({ ...base, floorSec: 300, strikes: "pending" }).delaySec).toBe(300);
  });
});

describe("failureDelaySec", () => {
  const base = { intervalSec: 300, retryAfterSec: null, floorSec: 60, random: 0.5 };

  it("never retries sooner than the board's normal rhythm", () => {
    expect(failureDelaySec({ ...base, failures: 1 })).toBe(300);
    expect(failureDelaySec({ ...base, failures: 2 })).toBe(300);
  });

  it("then doubles for every failure in a row", () => {
    expect(failureDelaySec({ ...base, failures: 3 })).toBe(480);
    expect(failureDelaySec({ ...base, failures: 4 })).toBe(960);
    expect(failureDelaySec({ ...base, failures: 5 })).toBe(1920);
    expect(failureDelaySec({ ...base, failures: 7 })).toBe(7680);
  });

  it("calls a board degraded after eight failures and tries it every six hours", () => {
    expect(failureDelaySec({ ...base, failures: 8 })).toBe(MAX_WAIT_SEC);
    expect(failureDelaySec({ ...base, failures: 500 })).toBe(MAX_WAIT_SEC);
  });

  it("does not overflow for absurd failure counts", () => {
    expect(failureDelaySec({ ...base, failures: Number.MAX_SAFE_INTEGER })).toBe(MAX_WAIT_SEC);
  });

  it("obeys Retry-After when it asks for more than the backoff does", () => {
    expect(failureDelaySec({ ...base, failures: 1, retryAfterSec: 3600 })).toBe(3600);
    expect(failureDelaySec({ ...base, failures: 1, retryAfterSec: 10 })).toBe(300);
  });

  it("adds jitter below the cap, never above Retry-After", () => {
    expect(failureDelaySec({ ...base, failures: 3, random: 0 })).toBe(432);
    expect(failureDelaySec({ ...base, failures: 3, random: 0.999999 })).toBe(528);
    expect(failureDelaySec({ ...base, failures: 3, random: 0, retryAfterSec: 500 })).toBe(500);
  });
});

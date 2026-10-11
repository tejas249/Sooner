/** The longest we ever wait before asking a board again, whatever a provider's Retry-After says. */
export const MAX_WAIT_SEC = 6 * 3600;

/**
 * Retry-After is either whole seconds or an HTTP date. Returns how many seconds to wait, or null when the header is
 * absent or unusable. A date in the past means "now" (0), and anything longer than MAX_WAIT_SEC is cut to it.
 */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | null {
  const v = value?.trim();
  if (!v) return null;
  let seconds: number;
  if (/^\d+$/.test(v)) {
    seconds = Number(v);
  } else if (/^[A-Za-z]{3,9}[ ,]/.test(v)) {
    // HTTP dates start with a day name ("Wed, 21 Oct 2026 ..."). Anything else is not one, and Date.parse is far too
    // forgiving to be trusted with it: it reads "-5" as a day in May 2001.
    const at = Date.parse(v);
    if (Number.isNaN(at)) return null;
    seconds = Math.ceil((at - now.getTime()) / 1000);
  } else {
    return null;
  }
  if (!Number.isFinite(seconds)) return null;
  return Math.min(Math.max(seconds, 0), MAX_WAIT_SEC);
}

/** A board somebody follows is checked this often. */
export const FOLLOWED_INTERVAL_SEC = 300;
/** A board nobody follows is never checked more often than this, however busy it is. */
export const UNFOLLOWED_MIN_INTERVAL_SEC = 1800;
/** After this many failures in a row a board is called degraded and is tried only once every MAX_WAIT_SEC. */
export const DEGRADED_AFTER_FAILURES = 8;
/** A role that is missing once is checked again this soon (the second strike), or this soon in a suspicious case. */
export const STRIKE_RECHECK_SEC = 120;
export const SUSPICIOUS_RECHECK_SEC = 600;

/**
 * The board's interval after a good answer, before jitter. This is what is stored in `poll_interval_sec`.
 *
 * A followed board is checked at a steady pace. A board nobody follows adapts: it speeds up (down to half, never below
 * 30 minutes) when it changed, and slows down (by half again, never above 6 hours) when it was quiet. That puts the
 * request budget where something is happening.
 *
 * (The guide's version adapted followed boards too, so a followed company that happened to be quiet drifted to one check
 * every six hours. Following a company is supposed to mean the opposite.)
 *
 * `floorSec` is the provider's own minimum: Ashby caches its answer for 60 seconds, so asking sooner is pointless.
 */
export function adaptInterval(input: { currentSec: number; changed: boolean; followed: boolean; floorSec: number }): number {
  const { currentSec, changed, followed, floorSec } = input;
  if (followed) return Math.max(FOLLOWED_INTERVAL_SEC, floorSec);
  const adapted = changed ? Math.max(UNFOLLOWED_MIN_INTERVAL_SEC, currentSec / 2) : Math.min(MAX_WAIT_SEC, currentSec * 1.5);
  return Math.max(Math.round(adapted), floorSec);
}

/**
 * Spreads boards out in time: up to 10% either way. Without it, boards that start together stay together and the load
 * arrives in waves. `random` is a number in [0, 1) and is passed in so a test can pin it down.
 */
export function withJitter(sec: number, random: number, floorSec = 0): number {
  return Math.max(Math.round(sec * (0.9 + 0.2 * random)), floorSec);
}

export type Strikes = "none" | "pending" | "suspicious";

/**
 * When to ask a board again after a good answer, and the interval to remember.
 *
 * Roles that are missing but not yet closed need their confirmation soon: 2 minutes, or 10 when so many vanished at once
 * that closing waits for three checks over 20 minutes. Otherwise the board's own rhythm applies.
 */
export function scheduleAfterSuccess(input: {
  currentSec: number;
  changed: boolean;
  followed: boolean;
  floorSec: number;
  strikes: Strikes;
  random: number;
}): { intervalSec: number; delaySec: number } {
  const intervalSec = adaptInterval(input);
  if (input.strikes !== "none") {
    const recheck = input.strikes === "suspicious" ? SUSPICIOUS_RECHECK_SEC : STRIKE_RECHECK_SEC;
    return { intervalSec, delaySec: Math.max(recheck, input.floorSec) };
  }
  return { intervalSec, delaySec: withJitter(intervalSec, input.random, input.floorSec) };
}

/**
 * When to try again after a failed poll: the longer of the board's normal rhythm and 60 seconds times two for every
 * failure so far, capped at six hours, with jitter. A provider that asks us to wait longer (Retry-After) wins. After
 * DEGRADED_AFTER_FAILURES failures in a row the board is tried once every six hours until it recovers.
 *
 * A failing board is therefore never asked more often than a healthy one: trouble is a reason to slow down.
 * `failures` counts this one, so it is at least 1.
 */
export function failureDelaySec(input: {
  failures: number;
  intervalSec: number;
  retryAfterSec: number | null;
  floorSec: number;
  random: number;
}): number {
  const backoff = Math.min(MAX_WAIT_SEC, 60 * 2 ** input.failures);
  const base = input.failures >= DEGRADED_AFTER_FAILURES ? MAX_WAIT_SEC : Math.max(input.intervalSec, backoff);
  const delay = withJitter(Math.min(base, MAX_WAIT_SEC), input.random, input.floorSec);
  return input.retryAfterSec === null ? delay : Math.max(delay, input.retryAfterSec);
}

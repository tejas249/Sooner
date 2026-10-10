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

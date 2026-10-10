/** Small formatting helpers for the command-line scripts. No dependencies. */

/** "just now", "4 min", "3 h", "12 d". `ms` is how long ago, so it should not be negative. */
export function formatAgo(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const m = Math.floor(seconds / 60);
  return `${m} m ${String(Math.round(seconds - m * 60)).padStart(2, "0")} s`;
}

/** Whole numbers with thousands separators: 14212 -> "14,212". */
export const formatCount = (n: number): string => n.toLocaleString("en-US");

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(max - 1, 0))}…`;
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

/** Linear-interpolated percentile (p from 0 to 1) of a list of numbers, or null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (at - lo);
}

/** Parses "90s", "5m", "2h" or a bare number of seconds into milliseconds. Throws on anything else. */
export function parseInterval(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(text.trim());
  if (!match) throw new Error(`"${text}" is not a duration. Use something like 90s, 5m or 2h.`);
  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  return Math.round(value * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000));
}

/**
 * Third-party text (job titles, places) is shown as plain text only. Control characters are replaced by spaces so a
 * title cannot move the cursor, recolour the terminal or hide other output with an escape sequence.
 */
export function safe(text: string): string {
  return [...text]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
    })
    .join("");
}

/** Pads text on the right to a column width, cutting it when it is too long. */
export const column = (text: string, width: number): string => truncate(text, width).padEnd(width);

const useColor = (): boolean => Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];
const paint = (code: number, text: string): string => (useColor() ? `\u001b[${code}m${text}\u001b[0m` : text);
export const green = (t: string): string => paint(32, t);
export const red = (t: string): string => paint(31, t);
export const yellow = (t: string): string => paint(33, t);
export const dim = (t: string): string => paint(2, t);
export const bold = (t: string): string => paint(1, t);

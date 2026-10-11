import { z } from "zod";
import { FeedFormatError } from "../errors.ts";
import { clean, hasControlCharacter } from "../text.ts";
import type { NormalizedJob, Provider } from "../types.ts";

/** What the rest of the system knows about a provider. Adapters parse; they never fetch. */
export interface Adapter {
  readonly provider: Provider;
  /** The one host we talk to for this provider. The politeness gate is keyed on it. */
  readonly host: string;
  /** Never poll faster than this, whatever the schedule says. Ashby caches its feed for 60 seconds. */
  readonly minIntervalSec: number;
  /** How long one request may take. Lever builds its answers slowly (a 6 MB board took 52 seconds). */
  readonly timeoutMs: number;
  /** Builds the feed URL. Only ever called with a token from our own list, never with text a user typed. */
  url(token: string): string;
  /** Throws FeedFormatError when the JSON is not the shape this provider is known to send. */
  parse(json: unknown): NormalizedJob[];
}

/** Board tokens end up inside URLs, so they are limited to the characters the providers actually use. */
export const TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertToken(token: string): void {
  if (!TOKEN_RE.test(token)) throw new RangeError(`not a valid board token: ${JSON.stringify(token)}`);
}

/**
 * Links to the employer are only ever stored, shown and followed as https. A few boards still publish http links
 * (Squarespace's whole Greenhouse board does), so http is upgraded rather than failing the board. Any other scheme,
 * such as javascript: or data:, or text that is not a URL at all, fails the response.
 */
export const employerUrl = z.string().transform((value, ctx) => {
  const trimmed = value.trim();
  if (hasControlCharacter(trimmed)) {
    ctx.addIssue({ code: "custom", message: "must not contain control characters" });
    return z.NEVER;
  }
  try {
    const { protocol } = new URL(trimmed);
    if (protocol === "https:") return trimmed;
    if (protocol === "http:") return `https:${trimmed.slice("http:".length)}`;
  } catch {
    // not a URL: fall through to the issue below
  }
  ctx.addIssue({ code: "custom", message: "must be an http or https URL" });
  return z.NEVER;
});

/**
 * The provider's own ID for a role. It is stored and compared as text, so it must be a plain, reasonably short string:
 * a control character in it (the database cannot store a NUL) means the feed is not what we think it is.
 */
export const providerId = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !hasControlCharacter(value), "must not contain control characters");

/** Dates arrive as ISO text with any offset, or as epoch milliseconds. Out: ISO in UTC, or null when unusable. */
export function toIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Cleaned text, or null when nothing is left. */
export function text(value: string | null | undefined): string | null {
  const cleaned = clean(value);
  return cleaned === "" ? null : cleaned;
}

/** A role without a readable title cannot be shown or matched, so the response is treated as malformed. */
export function requireTitle(provider: Provider, externalId: string, raw: string): string {
  const title = clean(raw);
  if (title === "") throw new FeedFormatError(provider, `role ${externalId} has an empty title`);
  return title;
}

export function parseFeed<S extends z.ZodType>(provider: Provider, schema: S, json: unknown): z.output<S> {
  const result = schema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new FeedFormatError(provider, `unexpected response shape (${first})`);
  }
  return result.data;
}

/**
 * The database keys a role on (board, external ID), so a repeated ID would be a constraint violation. More to the
 * point, it means the feed is not what we think it is.
 */
export function rejectDuplicateIds(provider: Provider, jobs: readonly NormalizedJob[]): void {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.externalId)) throw new FeedFormatError(provider, `role ID ${job.externalId} appears twice`);
    seen.add(job.externalId);
  }
}

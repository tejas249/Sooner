import { parseRetryAfter } from "../core/schedule.ts";
import type { HostGate } from "./gate.ts";

export interface FetchMeta {
  /** HTTP status, or null when the request never got an answer. */
  status: number | null;
  ms: number;
  /** Bytes of the decoded body that were read. */
  bytes: number;
}

export type FetchOutcome =
  | ({
      kind: "ok";
      text: string;
      etag: string | null;
      cacheControl: string | null;
      contentEncoding: string | null;
    } & FetchMeta)
  /** 304: the board has not changed since the ETag we sent. */
  | ({ kind: "unchanged" } & FetchMeta)
  /** Worth trying again later: 429, 5xx, a timeout or a network failure. */
  | ({ kind: "retry"; retryAfterSec: number | null; reason: string } & FetchMeta)
  /** Trying again will not help: a 4xx (404 means the board is gone), an unexpected redirect, a body that is too large. */
  | ({ kind: "error"; reason: string } & FetchMeta);

export interface FetcherOptions {
  userAgent: string;
  gate: HostGate;
  timeoutMs?: number;
  /** Bodies larger than this (after decoding) are refused. */
  maxBytes?: number;
  /** Only used to turn a Retry-After date into seconds. */
  now?: () => Date;
}

export interface GetOptions {
  /** The ETag from the last full answer. Sent as If-None-Match. */
  etag?: string | null;
  accept?: string;
  /** Provider feeds do not redirect, so by default a redirect is reported as an error. */
  maxRedirects?: number;
  /** Overrides the fetcher's size limit for this request. */
  maxBytes?: number;
  /** Overrides the fetcher's timeout for this request. Some providers are slow to build a big answer. */
  timeoutMs?: number;
  /** Cancels the request, for a worker that is shutting down. The outcome is a `retry` whose reason is "aborted". */
  signal?: AbortSignal;
}

export interface Fetcher {
  get(url: string, options?: GetOptions): Promise<FetchOutcome>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https everywhere; plain http only to this machine, which the tests need. */
function schemeAllowed(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
}

function describeFailure(error: unknown): string {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  if (error instanceof Error) {
    const cause: unknown = error.cause;
    const code = cause instanceof Error && "code" in cause ? String((cause as { code: unknown }).code) : null;
    return `network error (${code ?? error.message})`;
  }
  return "network error";
}

/** A signal that fires after `ms`, or as soon as `cancel` does, whichever comes first. */
function withTimeout(ms: number, cancel: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return cancel ? AbortSignal.any([timeout, cancel]) : timeout;
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number } | null> {
  if (!res.body) return { text: "", bytes: 0 };
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: total };
}

export function createFetcher(options: FetcherOptions): Fetcher {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? 15_000_000;
  const clock = options.now ?? (() => new Date());

  type Hop = FetchOutcome | { kind: "redirect"; status: number; location: string };

  /**
   * One request to one URL, taken through the gate. The gate slot is held until the body has been read. The time it
   * reports starts once the gate has let it through: waiting for a turn is our politeness, not the server's speed.
   */
  async function hop(target: URL, opts: GetOptions): Promise<Hop> {
    const release = await options.gate.acquire(target.host);
    if (opts.signal?.aborted) {
      release();
      throw opts.signal.reason;
    }
    const started = performance.now();
    const meta = (status: number | null, bytes = 0): FetchMeta => ({
      status,
      ms: Math.round(performance.now() - started),
      bytes,
    });
    try {
      const res = await fetch(target, {
        headers: {
          "User-Agent": options.userAgent,
          Accept: opts.accept ?? "application/json",
          ...(opts.etag ? { "If-None-Match": opts.etag } : {}),
        },
        // Without this, fetch sees our If-None-Match and adds "Cache-Control: no-cache" and "Pragma: no-cache" on its
        // own. Greenhouse and Ashby ignore that, but Lever takes it as "skip your cache": it ignores the ETag, never
        // answers 304 and rebuilds the whole list (6 to 10 seconds, 737 KB). "no-cache" mode sends the standard
        // "Cache-Control: max-age=0" instead, which just means "check that your copy is current".
        cache: opts.etag ? "no-cache" : "default",
        redirect: "manual",
        signal: withTimeout(opts.timeoutMs ?? timeoutMs, opts.signal),
      });

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        return { kind: "redirect", status: res.status, location };
      }
      if (res.status === 304) {
        await res.body?.cancel();
        return { kind: "unchanged", ...meta(304) };
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        return {
          kind: "retry",
          retryAfterSec: parseRetryAfter(res.headers.get("retry-after"), clock()),
          reason: `HTTP ${res.status}`,
          ...meta(res.status),
        };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { kind: "error", reason: `HTTP ${res.status}`, ...meta(res.status) };
      }

      const limit = opts.maxBytes ?? maxBytes;
      const body = await readCapped(res, limit);
      if (body === null) {
        return { kind: "error", reason: `response larger than ${limit} bytes`, ...meta(res.status) };
      }
      return {
        kind: "ok",
        text: body.text,
        etag: res.headers.get("etag"),
        cacheControl: res.headers.get("cache-control"),
        contentEncoding: res.headers.get("content-encoding"),
        ...meta(res.status, body.bytes),
      };
    } finally {
      release();
    }
  }

  async function get(url: string, opts: GetOptions = {}): Promise<FetchOutcome> {
    const started = performance.now();
    const meta = (status: number | null): FetchMeta => ({ status, ms: Math.round(performance.now() - started), bytes: 0 });
    const maxRedirects = opts.maxRedirects ?? 0;

    try {
      let target = new URL(url);
      for (let hops = 0; ; hops++) {
        if (!schemeAllowed(target)) return { kind: "error", reason: `refusing ${target.protocol} URL`, ...meta(null) };
        const step = await hop(target, opts);
        if (step.kind !== "redirect") return step;
        if (hops >= maxRedirects) {
          return { kind: "error", reason: `unexpected redirect (HTTP ${step.status})`, ...meta(step.status) };
        }
        target = new URL(step.location, target);
      }
    } catch (error) {
      return { kind: "retry", retryAfterSec: null, reason: opts.signal?.aborted ? "aborted" : describeFailure(error), ...meta(null) };
    }
  }

  return { get };
}

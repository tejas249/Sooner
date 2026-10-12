import { adapters as realAdapters } from "../core/adapters/index.ts";
import type { Adapter } from "../core/adapters/shared.ts";
import { FeedFormatError } from "../core/errors.ts";
import type { NormalizedJob, Provider } from "../core/types.ts";
import type { FetchMeta, Fetcher } from "./fetcher.ts";

export interface BoardRef {
  provider: Provider;
  token: string;
}

export type BoardFetch =
  | ({
      kind: "ok";
      jobs: NormalizedJob[];
      etag: string | null;
      cacheControl: string | null;
      contentEncoding: string | null;
      /** The raw answer. Only there when the caller asked for it (`keepText`): the worker never keeps it. */
      text?: string;
    } & FetchMeta)
  | ({ kind: "unchanged" } & FetchMeta)
  | ({ kind: "retry"; retryAfterSec: number | null; reason: string } & FetchMeta)
  | ({ kind: "error"; reason: string } & FetchMeta)
  /** The answer was not JSON, or not the shape this provider is known to send. A format change, never "all closed". */
  | ({ kind: "invalid"; reason: string } & FetchMeta);

/**
 * Fetch one board politely and turn the answer into roles. This is the only place a feed URL is built, and it is built
 * from an adapter and a token from our own list, never from text a user typed.
 *
 * `adapters` is the set of adapters to use. Nothing but a test passes one: it lets the whole worker be pointed at a mock
 * job-board server on this machine without a single line of the real code knowing it is a test.
 */
export async function fetchBoard(
  fetcher: Fetcher,
  board: BoardRef & { etag?: string | null },
  options: { signal?: AbortSignal; adapters?: Record<Provider, Adapter>; keepText?: boolean } = {},
): Promise<BoardFetch> {
  const adapter = (options.adapters ?? realAdapters)[board.provider];
  const outcome = await fetcher.get(adapter.url(board.token), {
    etag: board.etag,
    timeoutMs: adapter.timeoutMs,
    signal: options.signal,
  });
  if (outcome.kind !== "ok") return outcome;

  const { text, ...rest } = outcome;
  const meta: FetchMeta = { status: outcome.status, ms: outcome.ms, bytes: outcome.bytes };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: `${board.provider}: the answer is not JSON`, ...meta };
  }
  try {
    return {
      kind: "ok",
      jobs: adapter.parse(json),
      etag: rest.etag,
      cacheControl: rest.cacheControl,
      contentEncoding: rest.contentEncoding,
      ...(options.keepText ? { text } : {}),
      ...meta,
    };
  } catch (error) {
    if (error instanceof FeedFormatError) return { kind: "invalid", reason: error.message, ...meta };
    throw error;
  }
}

import type { Provider } from "../core/types.ts";

/** A board this worker has leased and is about to poll. */
export interface ClaimedBoard {
  id: string;
  companyId: string;
  companySlug: string;
  provider: Provider;
  token: string;
  /** The ETag of the last full answer, sent back as If-None-Match. */
  etag: string | null;
  /**
   * Proves this worker still holds the lease. Every write that finishes a poll is conditional on it, so a worker whose
   * lease ran out (it stalled, and another worker took the board over) cannot write over the new holder.
   */
  claimToken: string;
  pollIntervalSec: number;
  consecutiveFailures: number;
  baselinedAt: string | null;
}

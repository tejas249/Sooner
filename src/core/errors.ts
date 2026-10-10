import type { Provider } from "./types.ts";

/**
 * A provider's response did not look the way its adapter expects. Callers must treat this as "the provider changed
 * its format": change nothing, tell a human. It must never be read as "every role was closed".
 */
export class FeedFormatError extends Error {
  readonly provider: Provider;

  constructor(provider: Provider, message: string) {
    super(`${provider}: ${message}`);
    this.name = "FeedFormatError";
    this.provider = provider;
  }
}

/** At most this many requests to one host run at once, unless a gate is built with another number. */
export const DEFAULT_MAX_IN_FLIGHT = 2;

export interface GateClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: GateClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface GateOptions {
  /** Requests to one host start at least this far apart. */
  gapMs?: number;
  /**
   * At most this many requests to one host are in flight at once. The gap limits the rate, but a slow host (Lever
   * took 6 to 50 seconds to build one board) could still end up with many heavy requests running together.
   */
  maxInFlight?: number;
  clock?: GateClock;
}

/**
 * The politeness gate. For each host it keeps two promises: requests start at least `gapMs` apart, and no more than
 * `maxInFlight` are running at once. Hosts never wait for each other.
 *
 * `acquire` resolves when it is this request's turn and gives back a function that must be called when the request has
 * finished, success or not. Callers queue in the order they asked.
 */
export class HostGate {
  readonly #gapMs: number;
  readonly #maxInFlight: number;
  readonly #clock: GateClock;
  readonly #nextStart = new Map<string, number>();
  readonly #inFlight = new Map<string, number>();
  readonly #queue = new Map<string, Array<() => void>>();

  constructor(options: GateOptions = {}) {
    this.#gapMs = options.gapMs ?? 1000;
    this.#maxInFlight = Math.max(1, options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
    this.#clock = options.clock ?? realClock;
  }

  async acquire(host: string): Promise<() => void> {
    await this.#takeSlot(host);
    // Reserve the next free start time at once, before sleeping, so concurrent callers line up behind each other
    // instead of waking together. This happens after the slot is ours, so time spent queued for a slot is not wasted.
    const now = this.#clock.now();
    const at = Math.max(now, this.#nextStart.get(host) ?? 0);
    this.#nextStart.set(host, at + this.#gapMs);
    if (at > now) await this.#clock.sleep(at - now);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#giveSlot(host);
    };
  }

  async #takeSlot(host: string): Promise<void> {
    const running = this.#inFlight.get(host) ?? 0;
    if (running < this.#maxInFlight) {
      this.#inFlight.set(host, running + 1);
      return;
    }
    // Full: wait in line. The slot is handed over directly by #giveSlot, so the count stays as it is.
    await new Promise<void>((resolve) => {
      const waiting = this.#queue.get(host) ?? [];
      waiting.push(resolve);
      this.#queue.set(host, waiting);
    });
  }

  #giveSlot(host: string): void {
    const next = this.#queue.get(host)?.shift();
    if (next) {
      next();
      return;
    }
    this.#inFlight.set(host, Math.max(0, (this.#inFlight.get(host) ?? 1) - 1));
  }
}

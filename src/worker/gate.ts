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
 *
 * The gap is measured from when the previous request actually started. Planning every start at a fixed multiple of the gap
 * would not do: a timer that fires late (a big board being parsed, a busy database) would leave the next request closer
 * than the gap, because its own timer was not late.
 */
export class HostGate {
  readonly #gapMs: number;
  readonly #maxInFlight: number;
  readonly #clock: GateClock;
  /** When the latest request to each host really started. */
  readonly #lastStart = new Map<string, number>();
  /** Per host, the last caller in line for a start time. A caller begins waiting once the one before it has started. */
  readonly #turns = new Map<string, Promise<void>>();
  readonly #inFlight = new Map<string, number>();
  readonly #queue = new Map<string, Array<() => void>>();

  constructor(options: GateOptions = {}) {
    this.#gapMs = options.gapMs ?? 1000;
    this.#maxInFlight = Math.max(1, options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
    this.#clock = options.clock ?? realClock;
  }

  async acquire(host: string): Promise<() => void> {
    // The slot comes first, so time spent queued for a slot is not also spent waiting for a start time.
    await this.#takeSlot(host);
    await this.#waitForTurn(host);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#giveSlot(host);
    };
  }

  /** Resolves at the moment this caller may start. Callers to one host go one at a time, in the order they asked. */
  #waitForTurn(host: string): Promise<void> {
    const mine = (this.#turns.get(host) ?? Promise.resolve()).then(() => this.#waitForGap(host));
    this.#turns.set(
      host,
      mine.catch(() => undefined), // a failed wait must not hold up the callers behind it
    );
    return mine;
  }

  async #waitForGap(host: string): Promise<void> {
    for (;;) {
      const now = this.#clock.now();
      let last = this.#lastStart.get(host) ?? -Infinity;
      if (last > now) {
        // The clock was set back. Count from now, so the host is not kept waiting for a time that has not come: a wait is never more than one gap.
        last = now;
        this.#lastStart.set(host, now);
      }
      const wait = last + this.#gapMs - now;
      if (wait <= 0) break;
      await this.#clock.sleep(wait); // and look again: a timer can fire a little early or late
    }
    this.#lastStart.set(host, this.#clock.now());
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

/**
 * A sleep that can be cut short. The worker loop sleeps until the next board is due, but wakes at once when a poll
 * finishes (a lane has room again) or when it is told to stop.
 *
 * A `notify` that arrives while nobody is waiting is remembered, so the next `wait` returns immediately instead of
 * sleeping through news it missed.
 */
export class Wakeup {
  #wake: (() => void) | null = null;
  #notified = false;

  notify(): void {
    if (this.#wake) this.#wake();
    else this.#notified = true;
  }

  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.#notified) {
      this.#notified = false;
      return Promise.resolve();
    }
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.#wake = null;
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal?.addEventListener("abort", done, { once: true });
      this.#wake = done;
    });
  }
}

/**
 * Keeps a full restore from competing with the network for the neighbours.
 *
 * A restore asks the same nodes that are taking transactions, so it goes one
 * stream at a time, pauses between streams, pauses longer between batches,
 * and backs off further while the neighbours are slow to answer. It eases
 * back down once they speed up again.
 *
 * Set in the `restore` section of config.json. `"throttle": false` (or
 * `--fast`) turns it off for a node that is not serving anything.
 */
export interface IThrottleOptions {
  /** Pause before every stream */
  pauseMs: number;
  /** Streams per batch */
  batch: number;
  /** Extra pause after every batch */
  batchPauseMs: number;
  /** A stream that takes longer than this to fetch makes the restore back off */
  slowMs: number;
  /** The most the back-off can add to a pause */
  maxBackoffMs: number;
}

export const DEFAULT_THROTTLE: IThrottleOptions = {
  pauseMs: 5,
  batch: 100,
  batchPauseMs: 200,
  slowMs: 400,
  maxBackoffMs: 5000,
};

export class Throttle {
  private count = 0;
  private backoff = 0;

  constructor(
    private readonly options: IThrottleOptions | null,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  /**
   * Build one from the `restore` section of the config. `fast` or
   * `throttle: false` gives a throttle that never waits.
   */
  public static fromConfig(
    section: any,
    fast = false,
    sleep?: (ms: number) => Promise<void>
  ): Throttle {
    if (fast || section?.throttle === false) return new Throttle(null, sleep);
    const given = section?.throttle && typeof section.throttle === "object" ? section.throttle : {};
    const pick = (key: keyof IThrottleOptions) =>
      Number.isFinite(given[key]) && given[key] >= 0 ? given[key] : DEFAULT_THROTTLE[key];
    return new Throttle(
      {
        pauseMs: pick("pauseMs"),
        batch: Math.max(1, pick("batch")),
        batchPauseMs: pick("batchPauseMs"),
        slowMs: pick("slowMs"),
        maxBackoffMs: pick("maxBackoffMs"),
      },
      sleep
    );
  }

  /** The current back-off, for logging */
  public get backingOff(): number {
    return this.backoff;
  }

  /** Call before fetching each stream */
  public async wait(): Promise<void> {
    const o = this.options;
    if (!o) return;
    this.count++;
    let ms = o.pauseMs + this.backoff;
    if (this.count % o.batch === 0) ms += o.batchPauseMs;
    if (ms > 0) await this.sleep(ms);
  }

  /** Call with how long the fetch took */
  public record(durationMs: number): void {
    const o = this.options;
    if (!o) return;
    this.backoff =
      durationMs > o.slowMs
        ? Math.min(o.maxBackoffMs, Math.max(50, this.backoff * 2))
        : Math.floor(this.backoff / 2);
  }
}

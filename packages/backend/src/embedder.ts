import type { SearchIndex } from "./search-index.js";

/*
 * Embeds chunks in the background (files and memory design, decisions 27
 * and 28; plan P8, S6, S7, S8). Pending work is derived: any chunk without
 * a vector from the current embedding model. Writes never wait for this.
 *
 * - When the embedding model changes, vectors from other models are
 *   deleted and everything is embedded again with the new one.
 * - On failure it retries after 5 s, doubling up to 5 minutes; a success
 *   or a settings change resets the wait.
 * - With no embedding model set, it does nothing (search is keyword only).
 */

export const BATCH_SIZE = 16;
export const FIRST_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 300_000;

export interface EmbedderOptions {
  index: SearchIndex;
  /** The embedding model setting; empty: none. */
  model: () => string;
  embed: (
    model: string,
    texts: string[],
    signal?: AbortSignal,
  ) => Promise<number[][]>;
  /** Called with each failure (for logging). */
  onError?: (err: Error, retryInMs: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class Embedder {
  private running: Promise<void> | null = null;
  private again = false;
  private retryMs = FIRST_RETRY_MS;
  private timer: unknown = null;
  private stopped = false;
  private readonly controller = new AbortController();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly options: EmbedderOptions) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Starts work now if any is pending; safe to call often. */
  kick(): void {
    if (this.stopped) return;
    if (this.timer !== null) {
      // A retry is scheduled; new work does not cut the wait short.
      return;
    }
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.work().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** After a settings change: reset the wait and start over. */
  settingsChanged(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.retryMs = FIRST_RETRY_MS;
    this.kick();
  }

  /** Resolves when no work is running (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.controller.abort();
    await this.idle();
  }

  private async work(): Promise<void> {
    const model = this.options.model();
    if (!model) return;
    const { index } = this.options;
    index.dropOtherModels(model);
    for (;;) {
      if (this.stopped || this.options.model() !== model) return;
      const batch = index.pending(model, BATCH_SIZE);
      if (batch.length === 0) return;
      let vectors: number[][];
      try {
        vectors = await this.options.embed(
          model,
          batch.map((c) => c.text),
          this.controller.signal,
        );
      } catch (err) {
        if (this.stopped) return;
        const wait = this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
        this.options.onError?.(err as Error, wait);
        this.timer = this.setTimer(() => {
          this.timer = null;
          this.kick();
        }, wait);
        return;
      }
      // The setting may have changed while waiting.
      if (this.options.model() !== model) return;
      index.saveVectors(
        model,
        batch.map((c, i) => ({ id: c.id, vector: vectors[i] ?? [] })),
      );
      this.retryMs = FIRST_RETRY_MS;
    }
  }
}

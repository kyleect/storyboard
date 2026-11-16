import { isOversizeError, isResponseError } from "@harness/core";
import { withTaskPrefix } from "./embed-prefix.js";
import type { ChunkRow, SearchIndex } from "./search-index.js";

/*
 * Embeds chunks in the background (files and memory design, decisions 27
 * and 28; plan P8, S6, S7, S8). Pending work is derived: any chunk without
 * a vector from the current embedding model. Writes never wait for this.
 *
 * - When the embedding model changes, vectors from other models are
 *   deleted and everything is embedded again with the new one.
 * - On failure it retries after 5 s, doubling up to 5 minutes; a success
 *   or a settings change resets the wait.
 * - llama-server refuses an input that is too big for the model, and one
 *   such input fails the whole request. When it answers a batch with an
 *   error, the chunks are embedded one at a time. A chunk it refuses for
 *   its size, or for another reason while a tiny test input still works,
 *   is replaced by two or more smaller pieces of its text, which are
 *   embedded in turn. A piece of MIN_CHUNK_CHARS or fewer that is still
 *   refused is logged and left without a vector until the next restart or
 *   settings change, so it cannot hold up the rest. None of this counts as
 *   a failure for the wait above; only a server that cannot be reached, or
 *   that fails a test input too, does.
 * - With no embedding model set, it does nothing (search is keyword only).
 */

export const BATCH_SIZE = 16;
export const FIRST_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 300_000;
/** A chunk this short is not split further. */
export const MIN_CHUNK_CHARS = 200;
/** Embedded to tell a chunk that is refused from a server that is not well. */
const PROBE_TEXT = "ok";

/** What happened to a chunk that could not be embedded as it was. */
export type ChunkEvent =
  | {
      kind: "split";
      id: number;
      scope: ChunkRow["scope"];
      key: string;
      length: number;
      pieces: number;
    }
  | {
      kind: "skipped";
      id: number;
      scope: ChunkRow["scope"];
      key: string;
      length: number;
      reason: string;
    };

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
  /** Called when a chunk is split or given up on (for logging). */
  onChunk?: (event: ChunkEvent) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class Embedder {
  private running: Promise<void> | null = null;
  private again = false;
  private retryMs = FIRST_RETRY_MS;
  private timer: unknown = null;
  private stopped = false;
  /** Chunks given up on until a settings change (or a restart). */
  private readonly skipped = new Set<number>();
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
    this.skipped.clear();
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

  private embedChunks(model: string, chunks: ChunkRow[]): Promise<number[][]> {
    return this.options.embed(
      model,
      chunks.map((c) => withTaskPrefix(model, "document", c.text)),
      this.controller.signal,
    );
  }

  private async work(): Promise<void> {
    const model = this.options.model();
    if (!model) return;
    const { index } = this.options;
    index.dropOtherModels(model);
    for (;;) {
      if (this.stopped || this.options.model() !== model) return;
      const batch = index.pending(model, BATCH_SIZE, this.skipped);
      if (batch.length === 0) return;
      let failure: Error;
      try {
        const vectors = await this.embedChunks(model, batch);
        // The setting may have changed while waiting.
        if (this.options.model() !== model) return;
        this.save(model, batch, vectors);
        this.retryMs = FIRST_RETRY_MS;
        continue;
      } catch (err) {
        if (this.stopped) return;
        failure = err as Error;
      }
      if (isResponseError(failure)) {
        // The server answered with an error: some chunk may be to blame.
        const blamed = await this.isolate(model, batch);
        if (this.stopped || this.options.model() !== model) return;
        if (blamed === undefined) continue;
        failure = blamed;
      }
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
      this.options.onError?.(failure, wait);
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.kick();
      }, wait);
      return;
    }
  }

  private save(model: string, chunks: ChunkRow[], vectors: number[][]) {
    this.options.index.saveVectors(
      model,
      chunks.map((c, i) => ({ id: c.id, vector: vectors[i] ?? [] })),
    );
  }

  /**
   * Embeds the chunks of a refused batch one at a time. A chunk that is
   * refused is split or skipped (see the top of this file). Returns the error
   * of a server problem, when there is one: nothing more is done with this
   * batch then.
   */
  private async isolate(
    model: string,
    batch: ChunkRow[],
  ): Promise<Error | undefined> {
    for (const chunk of batch) {
      if (this.stopped || this.options.model() !== model) return undefined;
      try {
        const vectors = await this.embedChunks(model, [chunk]);
        if (this.options.model() !== model) return undefined;
        this.save(model, [chunk], vectors);
        this.retryMs = FIRST_RETRY_MS;
        continue;
      } catch (err) {
        if (this.stopped) return undefined;
        if (!isResponseError(err)) return err as Error;
        // A refusal for size is known; any other refusal is the chunk's
        // only when the server embeds a tiny input.
        if (!isOversizeError(err) && !(await this.serverWell(model))) {
          return err;
        }
        if (this.stopped) return undefined;
        this.tooBig(chunk, err.message);
      }
    }
    return undefined;
  }

  /** Whether the server embeds a tiny input. */
  private async serverWell(model: string): Promise<boolean> {
    try {
      await this.options.embed(
        model,
        [withTaskPrefix(model, "document", PROBE_TEXT)],
        this.controller.signal,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Splits a chunk the server refuses in two, or gives up on a short one. */
  private tooBig(chunk: ChunkRow, reason: string) {
    const { id, scope, key } = chunk;
    const length = chunk.text.length;
    const pieces =
      length > MIN_CHUNK_CHARS
        ? this.options.index.splitChunk(id, Math.floor(length / 2))
        : 0;
    if (pieces === undefined) return; // deleted meanwhile
    if (pieces >= 2) {
      this.options.onChunk?.({ kind: "split", id, scope, key, length, pieces });
      return;
    }
    this.skipped.add(id);
    this.options.onChunk?.({ kind: "skipped", id, scope, key, length, reason });
  }
}

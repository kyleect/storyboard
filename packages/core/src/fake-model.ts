import type { ModelAdapter, ModelChunk, ModelRequest } from "./model.js";

/** One step of a scripted response. */
export type ScriptStep =
  | ModelChunk
  /** Throw, as a failing model server would. */
  | { type: "throw"; message: string }
  /** Pause until the promise settles (for cancellation tests). */
  | { type: "wait"; until: Promise<unknown> };

/**
 * A model adapter that replays scripted responses, one per request, in order.
 * Records every request it receives.
 */
export class ScriptedModel implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private next = 0;

  constructor(private readonly scripts: ScriptStep[][]) {}

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    this.requests.push(request);
    const script = this.scripts[this.next++];
    if (!script) throw new Error("ScriptedModel: no script left");
    for (const step of script) {
      if (signal.aborted) return;
      if (step.type === "throw") throw new Error(step.message);
      if (step.type === "wait") {
        await Promise.race([step.until, abortPromise(signal)]);
        continue;
      }
      yield step;
    }
  }
}

function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

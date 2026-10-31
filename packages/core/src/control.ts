/** The outcome of a control request sent to the model server. */
export interface ControlResult {
  ok: boolean;
  /** Why it did not work, when `ok` is false. */
  message?: string;
}

/**
 * Lets the caller act on a response while it streams. The model adapter
 * binds the actions once the server has identified the response; until then,
 * and after the response ends, they report that they are not available.
 */
export class RunControl {
  private endReasoningImpl: (() => Promise<ControlResult>) | undefined;

  /** Called by the adapter. Pass undefined when the response has ended. */
  bindEndReasoning(fn: (() => Promise<ControlResult>) | undefined) {
    this.endReasoningImpl = fn;
  }

  /** Asks the model to stop reasoning and move on to its answer. */
  async endReasoning(): Promise<ControlResult> {
    if (!this.endReasoningImpl) {
      return {
        ok: false,
        message: "The response cannot be controlled right now.",
      };
    }
    return this.endReasoningImpl();
  }
}

import type { ModelAdapter, ModelChunk, ModelRequest } from "./model.js";
/** One step of a scripted response. */
export type ScriptStep = ModelChunk
/** Throw, as a failing model server would. */
 | {
    type: "throw";
    message: string;
}
/** Pause until the promise settles (for cancellation tests). */
 | {
    type: "wait";
    until: Promise<unknown>;
};
/**
 * A model adapter that replays scripted responses, one per request, in order.
 * Records every request it receives.
 */
export declare class ScriptedModel implements ModelAdapter {
    private readonly scripts;
    readonly requests: ModelRequest[];
    private next;
    constructor(scripts: ScriptStep[][]);
    stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
}

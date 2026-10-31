/**
 * A model adapter that replays scripted responses, one per request, in order.
 * Records every request it receives.
 */
export class ScriptedModel {
    scripts;
    requests = [];
    next = 0;
    constructor(scripts) {
        this.scripts = scripts;
    }
    async *stream(request, signal) {
        this.requests.push(request);
        const script = this.scripts[this.next++];
        if (!script)
            throw new Error("ScriptedModel: no script left");
        for (const step of script) {
            if (signal.aborted)
                return;
            if (step.type === "throw")
                throw new Error(step.message);
            if (step.type === "wait") {
                await Promise.race([step.until, abortPromise(signal)]);
                continue;
            }
            yield step;
        }
    }
}
function abortPromise(signal) {
    return new Promise((resolve) => {
        if (signal.aborted)
            return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}
//# sourceMappingURL=fake-model.js.map
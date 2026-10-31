/**
 * Runs one model request and emits the run's events.
 * Tool calls are reported, not executed.
 * Never throws for model errors: they end the run with `run.failed`.
 */
export async function runSingleCall(model, request, ctx) {
    const now = ctx.now ?? (() => new Date().toISOString());
    const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
    const emit = (body) => ctx.emit({
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        time: now(),
        ...body,
    });
    const continuing = ctx.continueMessage;
    const messageId = continuing?.messageId ?? ctx.messageId ?? newId();
    const blocks = continuing
        ? structuredClone(continuing.message.content)
        : [];
    const malformed = [];
    let open = null;
    const last = blocks.at(-1);
    if (last?.type === "text") {
        open = { type: "text", index: blocks.length - 1, text: last.text };
    }
    let usage;
    let finishReason = "stop";
    let failure;
    const closeOpen = () => {
        if (!open)
            return;
        blocks[open.index] = { type: open.type, text: open.text };
        emit({
            type: open.type === "text" ? "text.end" : "reasoning.end",
            data: { messageId, contentIndex: open.index, text: open.text },
        });
        open = null;
    };
    const openBlock = (type) => {
        if (open?.type === type)
            return open;
        closeOpen();
        const index = blocks.length;
        blocks.push({ type, text: "" });
        open = { type, index, text: "" };
        return open;
    };
    emit({
        type: "run.started",
        data: {
            kind: "single",
            ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
            ...(request.model ? { model: request.model } : {}),
        },
    });
    emit({
        type: "message.started",
        data: {
            messageId,
            role: "assistant",
            ...(continuing ? { continuing: true } : {}),
        },
    });
    try {
        for await (const chunk of model.stream(request, ctx.signal)) {
            if (ctx.signal.aborted)
                break;
            switch (chunk.type) {
                case "text": {
                    const block = openBlock("text");
                    block.text += chunk.text;
                    emit({
                        type: "text.delta",
                        data: {
                            messageId,
                            contentIndex: block.index,
                            text: chunk.text,
                            ...(chunk.tokens ? { tokens: chunk.tokens } : {}),
                            ...(usage ? { usage } : {}),
                        },
                    });
                    break;
                }
                case "reasoning": {
                    const block = openBlock("reasoning");
                    block.text += chunk.text;
                    emit({
                        type: "reasoning.delta",
                        data: {
                            messageId,
                            contentIndex: block.index,
                            text: chunk.text,
                            ...(usage ? { usage } : {}),
                        },
                    });
                    break;
                }
                case "tool_call": {
                    closeOpen();
                    let args;
                    try {
                        args = JSON.parse(chunk.arguments === "" ? "{}" : chunk.arguments);
                    }
                    catch (err) {
                        const error = `Invalid JSON in tool arguments: ${err.message}`;
                        malformed.push({ callId: chunk.callId, name: chunk.name, error });
                        emit({
                            type: "tool.malformed",
                            data: {
                                messageId,
                                callId: chunk.callId,
                                name: chunk.name,
                                error,
                            },
                        });
                        break;
                    }
                    const index = blocks.length;
                    blocks.push({
                        type: "tool_call",
                        callId: chunk.callId,
                        name: chunk.name,
                        arguments: args,
                    });
                    emit({
                        type: "tool.called",
                        data: {
                            messageId,
                            contentIndex: index,
                            callId: chunk.callId,
                            name: chunk.name,
                            arguments: args,
                        },
                    });
                    break;
                }
                case "usage":
                    usage = chunk.usage;
                    break;
                case "finish":
                    finishReason = chunk.reason;
                    break;
            }
        }
    }
    catch (err) {
        failure = err instanceof Error ? err.message : String(err);
    }
    if (failure !== undefined)
        finishReason = "error";
    else if (ctx.signal.aborted)
        finishReason = "cancelled";
    closeOpen();
    const message = { role: "assistant", content: blocks };
    emit({
        type: "message.finished",
        data: { messageId, message, finishReason, ...(usage ? { usage } : {}) },
    });
    if (failure !== undefined) {
        emit({ type: "run.failed", data: { error: failure } });
    }
    else {
        emit({
            type: "run.finished",
            data: {
                reason: finishReason === "cancelled" ? "cancelled" : "stop",
                ...(usage ? { usage } : {}),
            },
        });
    }
    return { message, finishReason, ...(usage ? { usage } : {}), malformed };
}
//# sourceMappingURL=run.js.map
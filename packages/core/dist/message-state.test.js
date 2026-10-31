import { describe, expect, it } from "vitest";
import { ScriptedModel } from "./fake-model.js";
import { buildMessageContent } from "./message-state.js";
import { runSingleCall } from "./run.js";
async function run(script, extra = {}, stopAfter) {
    const events = [];
    const result = await runSingleCall(new ScriptedModel([script]), { kind: "chat", messages: [] }, {
        runId: "r",
        sessionId: "s",
        signal: new AbortController().signal,
        emit: (e) => {
            if (!stopAfter || !events.some(stopAfter))
                events.push(e);
        },
        newId: () => "m1",
        ...extra,
    });
    return { events, result };
}
describe("buildMessageContent", () => {
    it("rebuilds the final message from the events", async () => {
        const { events, result } = await run([
            { type: "reasoning", text: "a" },
            { type: "reasoning", text: "b" },
            { type: "text", text: "c" },
            { type: "tool_call", callId: "t", name: "x", arguments: "{}" },
            { type: "text", text: "d" },
        ]);
        expect(buildMessageContent(events, "m1")).toEqual(result.message.content);
    });
    it("rebuilds a partial message from deltas only", async () => {
        const { events } = await run([
            { type: "reasoning", text: "think" },
            { type: "text", text: "Once " },
            { type: "text", text: "upon" },
        ], {}, (e) => e.type === "text.delta" && e.data.text === "upon");
        // Stopped before any *.end of the text block or message.finished.
        expect(buildMessageContent(events, "m1")).toEqual([
            { type: "reasoning", text: "think" },
            { type: "text", text: "Once upon" },
        ]);
    });
    it("ignores events for other messages", async () => {
        const { events } = await run([{ type: "text", text: "x" }]);
        expect(buildMessageContent(events, "other")).toEqual([]);
    });
});
describe("continuing a message", () => {
    const existing = {
        role: "assistant",
        content: [
            { type: "reasoning", text: "plan" },
            { type: "text", text: "Once upon" },
        ],
    };
    it("appends to the last text block under the same message id", async () => {
        const { events, result } = await run([
            { type: "text", text: " a time" },
            { type: "text", text: "." },
        ], { continueMessage: { messageId: "old", message: existing } });
        expect(events[1]).toMatchObject({
            type: "message.started",
            data: { messageId: "old", continuing: true },
        });
        expect(events[2]).toMatchObject({
            type: "text.delta",
            data: { messageId: "old", contentIndex: 1, text: " a time" },
        });
        expect(result.message.content).toEqual([
            { type: "reasoning", text: "plan" },
            { type: "text", text: "Once upon a time." },
        ]);
        expect(buildMessageContent(events, "old", existing.content)).toEqual(result.message.content);
        // The original is not modified.
        expect(existing.content[1]).toEqual({ type: "text", text: "Once upon" });
    });
    it("adds a new block when the message does not end with text", async () => {
        const { result } = await run([{ type: "text", text: "more" }], {
            continueMessage: {
                messageId: "old",
                message: {
                    role: "assistant",
                    content: [{ type: "reasoning", text: "r" }],
                },
            },
        });
        expect(result.message.content).toEqual([
            { type: "reasoning", text: "r" },
            { type: "text", text: "more" },
        ]);
    });
});
//# sourceMappingURL=message-state.test.js.map
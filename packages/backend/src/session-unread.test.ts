import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@harness/core";
import { Store } from "./store.js";
import { tempDatabase, type TempDatabase } from "./test-helpers.js";

/* Whether a session has an assistant reply the user has not seen yet. */

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

const user = (content: string): Message => ({ role: "user", content });
const asst = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const call = (callId: string): Message => ({
  role: "assistant",
  content: [
    { type: "tool_call", callId, name: "start_subagent", arguments: {} },
  ],
});

function setup() {
  temp = tempDatabase();
  const store = new Store(temp.db);
  store.createSession("s", "Session", "T0");
  let n = 0;
  const add = (id: string, message: Message, anchorId: string | null = null) =>
    store.addMessage(
      "s",
      id,
      message,
      `T${++n}`,
      undefined,
      undefined,
      anchorId,
    );
  const unread = () => store.listSessions().find((s) => s.id === "s")?.unread;
  const markSeen = () => store.markSeen("s");

  return { add, unread, markSeen };
}

describe("session unread", () => {
  it("is false for a session with no messages", () => {
    const t = setup();
    expect(t.unread()).toBe(false);
  });

  it("is false while the tip is the user's own message", () => {
    const t = setup();
    t.add("u1", user("hello"));
    expect(t.unread()).toBe(false);
  });

  it("is true once the assistant has replied", () => {
    const t = setup();
    t.add("u1", user("hello"));
    t.add("a1", asst("hi"));
    expect(t.unread()).toBe(true);
  });

  it("is false after the reply is seen, and true again for the next one", () => {
    const t = setup();
    t.add("u1", user("hello"));
    t.add("a1", asst("hi"));
    t.markSeen();
    expect(t.unread()).toBe(false);
    t.add("u2", user("more"));
    expect(t.unread()).toBe(false);
    t.add("a2", asst("sure"));
    expect(t.unread()).toBe(true);
  });

  it("ignores a subagent's messages", () => {
    const t = setup();
    t.add("u1", user("go"));
    t.add("a1", call("c1"));
    t.add("u2", user("next"));
    // A subagent reply, anchored to the call. The tip stays on the user's line.
    t.add("sub", asst("subagent says hi"), "a1");
    expect(t.unread()).toBe(false);
  });
});

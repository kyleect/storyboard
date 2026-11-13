import { describe, expect, it } from "vitest";
import { foldEdits } from "./files.js";
import type { Message, ToolResultMessage } from "./messages.js";
import {
  foldDecisionComments,
  formatDecisionComments,
} from "./decision-comments.js";

const result = (
  callId: string,
  name: string,
  decisionComment?: ToolResultMessage["decisionComment"],
): ToolResultMessage => ({
  role: "tool",
  callId,
  name,
  content: "r",
  isError: false,
  ...(decisionComment ? { decisionComment } : {}),
});

const calls = (...ids: string[]): Message => ({
  role: "assistant",
  content: ids.map((callId) => ({
    type: "tool_call" as const,
    callId,
    name: "t",
    arguments: {},
  })),
});

describe("formatDecisionComments", () => {
  it("is undefined when no result has a comment", () => {
    expect(formatDecisionComments([result("c1", "a")])).toBeUndefined();
    expect(formatDecisionComments([])).toBeUndefined();
  });

  it("uses the list format for a single comment", () => {
    expect(
      formatDecisionComments([
        result("c1", "write_entry", {
          text: "keep it under 200 words",
          choice: "once",
        }),
      ]),
    ).toBe(
      "The user's comments on this turn's tool calls:\n- write_entry (allowed): keep it under 200 words",
    );
  });

  it("lists the comments in call order with their outcome", () => {
    expect(
      formatDecisionComments([
        result("c1", "write_entry", { text: "short", choice: "once" }),
        result("c2", "read_entry"),
        result("c3", "web_search", {
          text: "use the comments",
          choice: "deny",
        }),
      ]),
    ).toBe(
      [
        "The user's comments on this turn's tool calls:",
        "- write_entry (allowed): short",
        "- web_search (denied): use the comments",
      ].join("\n"),
    );
  });

  it("adds the call id only for a tool called more than once in the turn", () => {
    expect(
      formatDecisionComments([
        result("c1", "write_entry", { text: "short", choice: "once" }),
        result("c2", "write_entry"),
        result("c3", "web_search", { text: "no", choice: "deny" }),
      ]),
    ).toBe(
      [
        "The user's comments on this turn's tool calls:",
        "- write_entry (allowed, c1): short",
        "- web_search (denied): no",
      ].join("\n"),
    );
  });
});

describe("foldDecisionComments", () => {
  const n1 = result("c1", "a", { text: "one", choice: "once" });
  const n2 = result("c2", "b", { text: "two", choice: "deny" });
  const comments12 =
    "The user's comments on this turn's tool calls:\n- a (allowed): one\n- b (denied): two";

  it("leaves messages without comments unchanged", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      calls("c1"),
      result("c1", "a"),
      { role: "user", content: "next" },
    ];
    expect(foldDecisionComments(messages)).toEqual(messages);
  });

  it("adds one comments message after the turn's last result", () => {
    expect(
      foldDecisionComments([calls("c1", "c2"), n1, n2, calls("c3")]),
    ).toEqual([
      calls("c1", "c2"),
      n1,
      n2,
      { role: "user", content: comments12 },
      calls("c3"),
    ]);
  });

  it("adds the comments message at the end of the transcript", () => {
    expect(foldDecisionComments([calls("c1", "c2"), n1, n2])).toEqual([
      calls("c1", "c2"),
      n1,
      n2,
      { role: "user", content: comments12 },
    ]);
  });

  it("puts the comments first in a user message that follows", () => {
    expect(
      foldDecisionComments([
        calls("c1", "c2"),
        n1,
        n2,
        { role: "user", content: "go" },
      ]),
    ).toEqual([
      calls("c1", "c2"),
      n1,
      n2,
      { role: "user", content: `${comments12}\n\ngo` },
    ]);
  });

  it("keeps the attachments of the user message the comments are put in", () => {
    const a = "session://photo.png";
    expect(
      foldDecisionComments([
        calls("c1", "c2"),
        n1,
        n2,
        { role: "user", content: "go", files: [a] },
      ]),
    ).toEqual([
      calls("c1", "c2"),
      n1,
      n2,
      { role: "user", content: `${comments12}\n\ngo`, files: [a] },
    ]);
  });

  it("keeps each turn's comments with that turn", () => {
    expect(foldDecisionComments([calls("c1"), n1, calls("c2"), n2])).toEqual([
      calls("c1"),
      n1,
      {
        role: "user",
        content:
          "The user's comments on this turn's tool calls:\n- a (allowed): one",
      },
      calls("c2"),
      n2,
      {
        role: "user",
        content:
          "The user's comments on this turn's tool calls:\n- b (denied): two",
      },
    ]);
  });

  it("puts the comments first when an edit message follows, once edits are folded", () => {
    expect(
      foldEdits(
        foldDecisionComments([
          calls("c1"),
          n1,
          { role: "edit", content: "[edit]", files: [] },
          { role: "user", content: "go" },
        ]),
      ),
    ).toEqual([
      calls("c1"),
      n1,
      {
        role: "user",
        content:
          "The user's comments on this turn's tool calls:\n- a (allowed): one\n\n[edit]\n\ngo",
      },
    ]);
  });
});

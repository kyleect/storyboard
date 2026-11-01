import { describe, expect, it } from "vitest";
import { foldEdits } from "./entries.js";
import type { Message, ToolResultMessage } from "./messages.js";
import { foldNotes, formatNotes } from "./notes.js";

const result = (
  callId: string,
  name: string,
  note?: ToolResultMessage["note"],
): ToolResultMessage => ({
  role: "tool",
  callId,
  name,
  content: "r",
  isError: false,
  ...(note ? { note } : {}),
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

describe("formatNotes", () => {
  it("is undefined when no result has a note", () => {
    expect(formatNotes([result("c1", "a")])).toBeUndefined();
    expect(formatNotes([])).toBeUndefined();
  });

  it("uses the list format for a single note", () => {
    expect(
      formatNotes([
        result("c1", "write_entry", {
          text: "keep it under 200 words",
          choice: "once",
        }),
      ]),
    ).toBe(
      "Notes on this turn's tool calls:\n- write_entry (allowed): keep it under 200 words",
    );
  });

  it("lists the notes in call order with their outcome", () => {
    expect(
      formatNotes([
        result("c1", "write_entry", { text: "short", choice: "once" }),
        result("c2", "read_entry"),
        result("c3", "web_search", { text: "use the notes", choice: "deny" }),
      ]),
    ).toBe(
      [
        "Notes on this turn's tool calls:",
        "- write_entry (allowed): short",
        "- web_search (denied): use the notes",
      ].join("\n"),
    );
  });

  it("adds the call id only for a tool called more than once in the turn", () => {
    expect(
      formatNotes([
        result("c1", "write_entry", { text: "short", choice: "once" }),
        result("c2", "write_entry"),
        result("c3", "web_search", { text: "no", choice: "deny" }),
      ]),
    ).toBe(
      [
        "Notes on this turn's tool calls:",
        "- write_entry (allowed, c1): short",
        "- web_search (denied): no",
      ].join("\n"),
    );
  });
});

describe("foldNotes", () => {
  const n1 = result("c1", "a", { text: "one", choice: "once" });
  const n2 = result("c2", "b", { text: "two", choice: "deny" });
  const notes12 =
    "Notes on this turn's tool calls:\n- a (allowed): one\n- b (denied): two";

  it("leaves messages without notes unchanged", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      calls("c1"),
      result("c1", "a"),
      { role: "user", content: "next" },
    ];
    expect(foldNotes(messages)).toEqual(messages);
  });

  it("adds one notes message after the turn's last result", () => {
    expect(foldNotes([calls("c1", "c2"), n1, n2, calls("c3")])).toEqual([
      calls("c1", "c2"),
      n1,
      n2,
      { role: "user", content: notes12 },
      calls("c3"),
    ]);
  });

  it("adds the notes message at the end of the transcript", () => {
    expect(foldNotes([calls("c1", "c2"), n1, n2])).toEqual([
      calls("c1", "c2"),
      n1,
      n2,
      { role: "user", content: notes12 },
    ]);
  });

  it("puts the notes first in a user message that follows", () => {
    expect(
      foldNotes([calls("c1", "c2"), n1, n2, { role: "user", content: "go" }]),
    ).toEqual([
      calls("c1", "c2"),
      n1,
      n2,
      { role: "user", content: `${notes12}\n\ngo` },
    ]);
  });

  it("keeps each turn's notes with that turn", () => {
    expect(foldNotes([calls("c1"), n1, calls("c2"), n2])).toEqual([
      calls("c1"),
      n1,
      {
        role: "user",
        content: "Notes on this turn's tool calls:\n- a (allowed): one",
      },
      calls("c2"),
      n2,
      {
        role: "user",
        content: "Notes on this turn's tool calls:\n- b (denied): two",
      },
    ]);
  });

  it("puts the notes first when an edit message follows, once edits are folded", () => {
    expect(
      foldEdits(
        foldNotes([
          calls("c1"),
          n1,
          { role: "edit", content: "[edit]", entries: [] },
          { role: "user", content: "go" },
        ]),
      ),
    ).toEqual([
      calls("c1"),
      n1,
      {
        role: "user",
        content:
          "Notes on this turn's tool calls:\n- a (allowed): one\n\n[edit]\n\ngo",
      },
    ]);
  });
});

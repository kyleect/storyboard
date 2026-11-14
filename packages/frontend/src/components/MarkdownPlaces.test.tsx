import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { Message, ToolResultMessage } from "@harness/core";
import { MessageView } from "../routes/chat/components/MessageView";
import { ValueView } from "./explorer/FileViews";

const wrap = (ui: ReactNode) => render(<MantineProvider>{ui}</MantineProvider>);

function chat(message: Message, streaming = false) {
  return wrap(
    <MessageView
      id="m1"
      message={message}
      model={null}
      reasoningEffort={null}
      agent={null}
      streaming={streaming}
      decisionComments={new Map()}
      asks={{
        results: new Map(),
        opens: [],
        submitted: new Map(),
        busy: false,
        onAnswer: () => {},
        subagents: new Map(),
        onSendToSubagent: () => {},
        sendingToSubagent: false,
      }}
    />,
  );
}

describe("Markdown in the chat", () => {
  it("renders a user message", () => {
    const { container } = chat({ role: "user", content: "Make it **short**" });

    expect(container.textContent).toContain("Make it short");
    expect(container.textContent).not.toContain("**");
  });

  it("renders assistant text but not reasoning", () => {
    const { container } = chat({
      role: "assistant",
      content: [
        { type: "reasoning", text: "I will use **bold** here" },
        { type: "text", text: "# Chapter 1\n\n- a\n- b" },
      ],
    });

    expect(screen.getByRole("heading", { name: "Chapter 1" })).toBeTruthy();
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).toContain("I will use **bold** here");
  });

  it("renders an edit message", () => {
    chat({
      role: "edit",
      content: "The user changed file `outline.md`.",
      files: [],
    });
    expect(screen.getByText("outline.md").tagName).toBe("CODE");
  });

  it("leaves tool results as code", () => {
    const result: ToolResultMessage = {
      role: "tool",
      callId: "c1",
      name: "read_entry",
      content: "# not a heading",
      isError: false,
    };
    const { container } = chat(result);

    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.textContent).toContain("# not a heading");
  });
});

describe("Markdown in files", () => {
  it("renders a markdown file and switches to its source", () => {
    const { container } = wrap(
      <ValueView mediaType="text/markdown" value={"# Outline\n\n- one"} />,
    );

    expect(screen.getByRole("heading", { name: "Outline" })).toBeTruthy();
    fireEvent.click(screen.getByText("Source"));
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.textContent).toContain("# Outline");
    fireEvent.click(screen.getByText("Rendered"));
    expect(screen.getByRole("heading", { name: "Outline" })).toBeTruthy();
  });

  it("shows an empty markdown file as (empty)", () => {
    wrap(<ValueView mediaType="text/markdown" value="" />);
    expect(screen.getByText("(empty)")).toBeTruthy();
  });

  it("leaves plain and json files as they were", () => {
    const { container, unmount } = wrap(
      <ValueView mediaType="text/plain" value={"# not a heading"} />,
    );

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByText("Rendered")).toBeNull();
    expect(container.textContent).toContain("# not a heading");
    unmount();
    const json = wrap(
      <ValueView mediaType="application/json" value={'{"a":1}'} />,
    );

    expect(screen.queryByText("Rendered")).toBeNull();
    expect(json.container.textContent).toContain('"a": 1');
  });
});

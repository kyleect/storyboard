import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InputRequest, Message } from "@harness/core";
import { MessageView } from "./Chat";

/* The work of a subagent under the call that started it (agent delegation design, decision 42). */

const call: Message = {
  role: "assistant",
  content: [
    {
      type: "tool_call",
      callId: "p1",
      name: "start_subagent",
      arguments: { agentId: "a1", task: "Tighten chapter 1" },
    },
  ],
};

const form: InputRequest = {
  requestId: "q1",
  callId: "k1",
  form: {
    title: "A question",
    fields: [
      { name: "name", label: "Your name", kind: "text", required: true },
    ],
  },
} as InputRequest;

type Subagents = Parameters<typeof MessageView>[0]["asks"]["subagents"];

function view(
  subagent: {
    running: boolean;
    waiting: boolean;
    messages?: object[];
    queued?: string[];
  },
  opens: { request: InputRequest; runId: string }[] = [],
  onAnswer = vi.fn(),
) {
  const onSendToSubagent = vi.fn();
  const subagents: Subagents = new Map([
    [
      "p1",
      {
        agentName: "Editor",
        running: subagent.running,
        runId: subagent.running ? "child-run" : null,
        queued: subagent.queued ?? [],
        waiting: subagent.waiting,
        messages: (subagent.messages ?? [
          {
            id: "m1",
            message: { role: "user", content: "Tighten chapter 1" },
            model: null,
            reasoningEffort: null,
            agent: null,
            streaming: false,
          },
          {
            id: "m2",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  callId: "k1",
                  name: "ask_user",
                  arguments: {
                    schema: {
                      title: "A question",
                      properties: {
                        name: { type: "string", title: "Your name" },
                      },
                      required: ["name"],
                    },
                  },
                },
              ],
            },
            model: null,
            reasoningEffort: null,
            agent: null,
            streaming: false,
          },
        ]) as never,
      },
    ],
  ]);
  render(
    <MantineProvider>
      <MessageView
        id="m0"
        message={call}
        model={null}
        reasoningEffort={null}
        agent={null}
        streaming={false}
        notes={new Map()}
        asks={{
          results: new Map(),
          opens,
          submitted: new Map(),
          busy: false,
          onAnswer,
          subagents,
          onSendToSubagent,
          sendingToSubagent: false,
        }}
      />
    </MantineProvider>,
  );
  return { onAnswer, onSendToSubagent };
}

describe("a subagent under its call", () => {
  it("is collapsed while it works, and opens on request", () => {
    view({ running: true, waiting: false });
    expect(screen.getByText("Editor")).toBeTruthy();
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.queryByText("Task from the agent")).toBeNull();

    fireEvent.click(screen.getByText("Show its work"));
    expect(screen.getByText("Task from the agent")).toBeTruthy();
    expect(screen.getByText("Hide its work")).toBeTruthy();
  });

  it("is open while it waits for the user, and its form goes to its own run", () => {
    const { onAnswer } = view({ running: true, waiting: true }, [
      { request: form, runId: "child-run" },
    ]);
    expect(screen.getByText("waiting for you")).toBeTruthy();
    expect(screen.getByText("Hide its work")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Your name/), {
      target: { value: "Ada" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit|answer/i }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    const [open, answer] = onAnswer.mock.calls[0] as [
      { runId: string },
      { outcome: string },
    ];
    expect(open.runId).toBe("child-run");
    expect(answer.outcome).toBe("answered");
  });

  it("says when it is done", () => {
    view({ running: false, waiting: false });
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("stays closed once the user closes it, even while it waits", () => {
    view({ running: true, waiting: true }, [
      { request: form, runId: "child-run" },
    ]);
    fireEvent.click(screen.getByText("Hide its work"));
    expect(screen.getByText("Show its work")).toBeTruthy();
  });
});

describe("a message to a running subagent", () => {
  const open = () => fireEvent.click(screen.getByText("Show its work"));

  it("has a box in its panel that sends to its own run", () => {
    const { onSendToSubagent } = view({ running: true, waiting: false });
    open();
    const box = screen.getByLabelText("Message to Editor");
    fireEvent.change(box, { target: { value: "  Use tool_b  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSendToSubagent).toHaveBeenCalledWith(
      "child-run",
      "  Use tool_b  ",
    );
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("sends with Ctrl+Enter", () => {
    const { onSendToSubagent } = view({ running: true, waiting: false });
    open();
    const box = screen.getByLabelText("Message to Editor");
    fireEvent.change(box, { target: { value: "Stop" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(onSendToSubagent).toHaveBeenCalledWith("child-run", "Stop");
  });

  it("does not send an empty message", () => {
    const { onSendToSubagent } = view({ running: true, waiting: false });
    open();
    const button = screen.getByRole("button", { name: "Send" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Message to Editor"), {
      key: "Enter",
      ctrlKey: true,
    });
    expect(onSendToSubagent).not.toHaveBeenCalled();
  });

  it("is not offered once the subagent is done", () => {
    view({ running: false, waiting: false });
    open();
    expect(screen.queryByLabelText("Message to Editor")).toBeNull();
  });

  it("shows a message as waiting until the subagent reads it", () => {
    view({ running: true, waiting: false, queued: ["Use tool_b"] });
    open();
    expect(screen.getByText("Use tool_b")).toBeTruthy();
    expect(screen.getByText(/waiting for its next step/)).toBeTruthy();
  });

  it("labels its user messages by where they came from", () => {
    const user = (id: string, content: string, source?: string) => ({
      id,
      message: { role: "user", content, ...(source ? { source } : {}) },
      model: null,
      reasoningEffort: null,
      agent: null,
      streaming: false,
    });
    view({
      running: true,
      waiting: false,
      messages: [
        user("m1", "Do it", "task"),
        user("m2", "Hand back.", "reminder"),
        user("m3", "Use tool_b", "user"),
        // Saved before the source was recorded: by position.
        user("m4", "Old reminder"),
      ],
    });
    open();
    expect(screen.getByText("Task from the agent")).toBeTruthy();
    expect(screen.getAllByText("Reminder")).toHaveLength(2);
    expect(screen.getByText("You, to the subagent")).toBeTruthy();
  });
});

import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApprovalAnswer } from "@harness/core";
import { ApprovalDialog } from "./ApprovalDialog";

function setup(alwaysAsks = false, agentSetting = false, from?: string) {
  const answers: ApprovalAnswer[] = [];
  render(
    <MantineProvider>
      <ApprovalDialog
        request={{
          requestId: "r1",
          callId: "c1",
          name: "write_entry",
          arguments: { text: "a" },
          ...(alwaysAsks ? { alwaysAsks } : {}),
          ...(agentSetting ? { agentSetting } : {}),
        }}
        opened
        busy={false}
        onClose={() => {}}
        onAnswer={(a) => answers.push(a)}
        {...(from ? { from } : {})}
      />
    </MantineProvider>,
  );
  const button = (name: string) =>
    screen.getByRole("button", { name }) as HTMLButtonElement;
  const type = (text: string) =>
    fireEvent.change(
      screen.getByPlaceholderText("Note for the model (optional)"),
      { target: { value: text } },
    );
  return { answers, button, type };
}

describe("ApprovalDialog", () => {
  for (const [label, choice] of [
    ["Allow once", "once"],
    ["Deny", "deny"],
  ] as const) {
    it(`sends the note with ${label}`, () => {
      const { answers, button, type } = setup();
      type("  keep it short ");
      fireEvent.click(button(label));
      expect(answers).toEqual([{ choice, note: "keep it short" }]);
    });
  }

  it("sends no note when the box is empty or blank", () => {
    const { answers, button, type } = setup();
    fireEvent.click(button("Allow once"));
    type("   ");
    fireEvent.click(button("Deny"));
    expect(answers).toEqual([{ choice: "once" }, { choice: "deny" }]);
  });

  it("disables the session and always choices while there is a note", () => {
    const { answers, button, type } = setup();
    expect(button("Allow for this session").disabled).toBe(false);
    expect(button("Always allow this tool").disabled).toBe(false);

    type("x");
    expect(button("Allow for this session").disabled).toBe(true);
    expect(button("Always allow this tool").disabled).toBe(true);
    expect(button("Allow once").disabled).toBe(false);
    expect(button("Deny").disabled).toBe(false);

    type("");
    expect(button("Allow for this session").disabled).toBe(false);
    fireEvent.click(button("Allow for this session"));
    expect(answers).toEqual([{ choice: "session" }]);
  });

  it("explains a disabled choice in a tooltip", async () => {
    const { button, type } = setup();
    type("x");
    const wrapper = button("Always allow this tool").parentElement;
    expect(wrapper).not.toBeNull();
    fireEvent.mouseEnter(wrapper as HTMLElement);
    expect(await screen.findByText("Clear the note to use this")).toBeDefined();
  });

  it("offers only Allow once and Deny for a tool that always asks", () => {
    const { answers, button } = setup(true);
    expect(
      screen.queryByRole("button", { name: "Allow for this session" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Always allow this tool" }),
    ).toBeNull();
    fireEvent.click(button("Allow once"));
    fireEvent.click(button("Deny"));
    expect(answers).toEqual([{ choice: "once" }, { choice: "deny" }]);
  });

  it("leaves out Always allow when the agent's setting makes the tool ask", () => {
    const { answers, button } = setup(false, true);
    expect(
      screen.queryByRole("button", { name: "Always allow this tool" }),
    ).toBeNull();
    expect(
      screen.getByText(/This agent asks before using this tool/),
    ).toBeDefined();
    fireEvent.click(button("Allow for this session"));
    fireEvent.click(button("Allow once"));
    fireEvent.click(button("Deny"));
    expect(answers).toEqual([
      { choice: "session" },
      { choice: "once" },
      { choice: "deny" },
    ]);
  });

  it("shows no such line otherwise", () => {
    setup();
    expect(screen.queryByText(/This agent asks before/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Always allow this tool" }),
    ).toBeDefined();
  });
});

describe("ApprovalDialog with changes (schemas and data design)", () => {
  const review = {
    items: [
      {
        key: "data",
        label: 'Task "Scene"',
        before: { name: "Scene", value: { task: "draft", done: false } },
        after: { name: "Scene", value: { task: "final", done: true } },
        changes: [
          {
            path: "/value/task",
            kind: "changed" as const,
            before: "draft",
            after: "final",
          },
          {
            path: "/value/done",
            kind: "changed" as const,
            before: false,
            after: true,
          },
        ],
      },
    ],
  };

  function changes(
    check: (s: unknown) => { errors: string[]; stale: boolean } = () => ({
      errors: [],
      stale: false,
    }),
  ) {
    const answers: ApprovalAnswer[] = [];
    const checked: unknown[] = [];
    render(
      <MantineProvider>
        <ApprovalDialog
          request={{
            requestId: "r1",
            callId: "c1",
            name: "data_update",
            arguments: {},
            review,
          }}
          opened
          busy={false}
          onClose={() => {}}
          onAnswer={(a) => answers.push(a)}
          onCheck={(s) => {
            checked.push(s);
            return Promise.resolve(check(s));
          }}
          onRefresh={() =>
            Promise.resolve({
              requestId: "r1",
              callId: "c1",
              name: "data_update",
              arguments: {},
              review,
            })
          }
        />
      </MantineProvider>,
    );
    const button = (name: string) =>
      screen.getByRole("button", { name }) as HTMLButtonElement;
    return { answers, checked, button };
  }

  it("approves only the ticked changes", () => {
    const { answers, button } = changes();
    fireEvent.click(screen.getByLabelText('Task "Scene": value › task'));
    fireEvent.click(button("Approve selected"));
    expect(answers).toEqual([
      { choice: "once", selection: { data: ["/value/done"] } },
    ]);
  });

  it("sends no selection when everything is ticked, and Approve all and Deny all answer the call", () => {
    const { answers, button } = changes();
    fireEvent.click(button("Approve selected"));
    fireEvent.click(button("Approve all"));
    fireEvent.click(button("Deny all"));
    expect(answers).toEqual([
      { choice: "once" },
      { choice: "once" },
      { choice: "deny" },
    ]);
  });

  it("blocks a selection the schema refuses, with the reason", async () => {
    const { button } = changes(() => ({
      errors: ["(value): missing required property 'task'."],
      stale: false,
    }));
    expect(
      await screen.findByText("(value): missing required property 'task'."),
    ).toBeTruthy();
    expect(button("Approve selected").disabled).toBe(true);
  });

  it("offers Refresh and Reject when the data changed meanwhile", async () => {
    const { answers, button } = changes(() => ({ errors: [], stale: true }));
    expect(
      await screen.findByText("The data changed since this was asked"),
    ).toBeTruthy();
    expect(button("Approve all").disabled).toBe(true);
    fireEvent.click(button("Reject"));
    expect(answers).toEqual([{ choice: "deny" }]);
  });
});

describe("ApprovalDialog from a subagent", () => {
  it("says which subagent is asking", () => {
    setup(false, false, "Editor");
    expect(screen.getByText("Editor is asking")).toBeTruthy();
    expect(screen.getByText("subagent")).toBeTruthy();
  });

  it("says nothing extra for the top-level agent", () => {
    setup();
    expect(screen.queryByText(/is asking/)).toBeNull();
  });
});

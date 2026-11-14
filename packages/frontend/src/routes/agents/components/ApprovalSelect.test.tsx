import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ToolApprovalInfo } from "../../../api";
import { ApprovalSelect } from "../Agents";

/* The agent editor's approval choice for one tool (agent tool approval design, Q1, Q2, Q4, Q5). */

const tool = (over: Partial<ToolApprovalInfo> = {}): ToolApprovalInfo => ({
  name: "web_fetch",
  description: "Fetches a page.",
  group: "web",
  alwaysOn: false,
  ask: false,
  fixed: false,
  ...over,
});

function setup(props: {
  tool?: ToolApprovalInfo | undefined;
  value?: boolean | undefined;
  disabled?: boolean;
}) {
  const changes: (boolean | undefined)[] = [];
  render(
    <MantineProvider>
      <ApprovalSelect
        tool={"tool" in props ? props.tool : tool()}
        value={props.value}
        disabled={props.disabled ?? false}
        onChange={(v) => changes.push(v)}
      />
    </MantineProvider>,
  );
  // The dropdown list carries the label too; the input is the one to use.
  const input = screen
    .getAllByLabelText("Approval for web_fetch")
    .find((el) => el.tagName === "INPUT") as HTMLInputElement;
  return { changes, input };
}

describe("ApprovalSelect", () => {
  it("shows the tool's setting when the agent has none", () => {
    expect(setup({}).input.value).toBe("Tool's setting (doesn't ask)");
  });

  it("shows the tool's setting as asking when it does", () => {
    expect(setup({ tool: tool({ ask: true }) }).input.value).toBe(
      "Tool's setting (asks)",
    );
  });

  it("shows the agent's own choice", () => {
    expect(setup({ value: true }).input.value).toBe("Ask");
  });

  it("shows Don't ask for a choice of false", () => {
    expect(setup({ value: false }).input.value).toBe("Don't ask");
  });

  it("is locked for a tool that always asks", () => {
    const { input } = setup({ tool: tool({ fixed: true, ask: true }) });
    expect(input.value).toBe("Always asks");
    expect(input.disabled).toBe(true);
  });

  it("is disabled for a tool the agent does not have, and keeps its value", () => {
    const { input } = setup({ value: true, disabled: true });
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("Ask");
  });

  it("reports a choice, and undefined for the tool's own setting", () => {
    const { changes, input } = setup({ value: true });
    fireEvent.click(input);
    fireEvent.click(screen.getByRole("option", { name: "Don't ask" }));
    fireEvent.click(input);
    fireEvent.click(
      screen.getByRole("option", { name: "Tool's setting (doesn't ask)" }),
    );
    expect(changes).toEqual([false, undefined]);
  });
});

import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApprovalAnswer } from "@harness/core";
import { ApprovalDialog } from "./ApprovalDialog";

function setup() {
  const answers: ApprovalAnswer[] = [];
  render(
    <MantineProvider>
      <ApprovalDialog
        request={{
          requestId: "r1",
          callId: "c1",
          name: "write_entry",
          arguments: { text: "a" },
        }}
        opened
        busy={false}
        onClose={() => {}}
        onAnswer={(a) => answers.push(a)}
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
});

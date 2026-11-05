import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  readSchemaForm,
  type InputAnswer,
  type SchemaNode,
} from "@harness/core";
import { AskUserForm, fromInput, localOffset, toInput } from "./AskUserForm";
import { errorsFromMessage } from "./Data";

/* Data forms (schemas and data design, decisions 19 to 21; plan P3). */

const CHARACTER: SchemaNode = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name" },
    stats: {
      type: "object",
      title: "Stats",
      properties: { hp: { type: "integer", title: "HP" } },
    },
    inventory: {
      type: "array",
      title: "Item",
      items: {
        type: "object",
        properties: { item: { type: "string", title: "What" } },
        required: ["item"],
      },
    },
  },
  required: ["name"],
};

describe("errorsFromMessage", () => {
  const form = readSchemaForm(CHARACTER);

  it("puts the backend's problems on their fields", () => {
    expect(
      errorsFromMessage(
        form,
        "It cannot be saved:\n- (value): missing required property 'name'.\n- /inventory/0/item: must be string.",
      ),
    ).toEqual({
      name: "Answer this question.",
      "inventory.0.item": "must be string.",
    });
  });

  it("names the one question of a scalar form value", () => {
    const flag = readSchemaForm({ type: "boolean" });
    expect(errorsFromMessage(flag, "x:\n- (value): must be boolean.")).toEqual({
      value: "must be boolean.",
    });
  });

  it("gives nothing for a message without field problems", () => {
    expect(errorsFromMessage(form, "The name is required.")).toBeUndefined();
  });
});

describe("times and dates in forms", () => {
  it("stores a date-time in UTC and shows it in local time", () => {
    const stored = fromInput("date-time", "2026-11-04T10:30");
    expect(stored).toMatch(/Z$/);
    expect(toInput("date-time", stored)).toBe("2026-11-04T10:30");
  });

  it("stores a time with the browser's offset", () => {
    expect(fromInput("time", "10:30")).toBe(`10:30:00${localOffset()}`);
    expect(toInput("time", "10:30:00+02:00")).toBe("10:30");
    expect(localOffset(new Date())).toMatch(/^[+-]\d{2}:\d{2}$/);
  });
});

describe("AskUserForm with groups and lists", () => {
  function open(initial = {}) {
    const answers: InputAnswer[] = [];
    render(
      <MantineProvider>
        <AskUserForm
          form={{ ...readSchemaForm(CHARACTER), submitLabel: "Save" }}
          initial={initial}
          heading={false}
          state={{
            mode: "open",
            requestId: "f",
            busy: false,
            onAnswer: (a) => answers.push(a),
          }}
        />
      </MantineProvider>,
    );
    return answers;
  }

  it("starts from the data and saves nested values", () => {
    const answers = open({
      name: "Mara",
      stats: { hp: 12 },
      inventory: [{ item: "knife" }],
    });
    expect((screen.getByLabelText(/^What/) as HTMLInputElement).value).toBe(
      "knife",
    );
    expect(screen.queryByText("Questions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Item" }));
    fireEvent.change(screen.getAllByLabelText(/^What/)[1] as HTMLElement, {
      target: { value: "rope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(answers).toEqual([
      {
        outcome: "answered",
        answers: {
          name: "Mara",
          stats: { hp: 12 },
          inventory: [{ item: "knife" }, { item: "rope" }],
        },
      },
    ]);
  });

  it("removes a list item and marks a missing field inside a new one", async () => {
    const answers = open({ name: "Mara", inventory: [{ item: "knife" }] });
    fireEvent.click(screen.getByRole("button", { name: "Remove Item 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Item" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(answers).toEqual([]);
    expect(await screen.findByText("Answer this question.")).toBeTruthy();
    expect(screen.queryByDisplayValue("knife")).toBeNull();
  });
});

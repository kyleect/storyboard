import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataValue } from "./DataValue";

function show(schema: unknown, value: unknown) {
  render(
    <MantineProvider>
      <DataValue schema={schema} value={value} />
    </MantineProvider>,
  );
}

describe("DataValue", () => {
  it("shows each field's label and value, not a form", () => {
    show(
      {
        type: "object",
        properties: {
          title: { type: "string", title: "Title" },
          status: { type: "string", enum: ["todo", "done"] },
          urgent: { type: "boolean", title: "Urgent" },
          notes: { type: "string", title: "Notes" },
        },
      },
      { title: "Draft scene 2", status: "done", urgent: false },
    );
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("Draft scene 2")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
    expect(screen.getByText("(empty)")).toBeTruthy();
    expect(screen.queryByText("Questions")).toBeNull();
    expect(screen.queryByText("Answered")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("nests groups and numbers list items", () => {
    show(
      {
        type: "object",
        properties: {
          inventory: {
            type: "array",
            title: "Inventory",
            items: {
              type: "object",
              properties: { item: { type: "string", title: "Item" } },
            },
          },
        },
      },
      { inventory: [{ item: "knife" }, { item: "rope" }] },
    );
    expect(screen.getByText("Inventory")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("rope")).toBeTruthy();
  });

  it("shows a top-level scalar", () => {
    show({ type: "boolean", title: "Done?" }, true);
    expect(screen.getByText("Done?")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
  });
});

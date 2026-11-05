import { describe, expect, it } from "vitest";
import { schemasInstruction, schemasText } from "./schemas-data.js";

describe("the schema list (decisions 37, 38)", () => {
  const schemas = [
    {
      id: "a1",
      name: "Task",
      scope: "global" as const,
      description: "A task\nto do.",
    },
    {
      id: "b2",
      name: "Note",
      scope: "session" as const,
      description: "A note.",
    },
  ];

  it("lists each schema with its id, scope and description on one line", () => {
    expect(schemasText(schemas)).toBe(
      "- Task (id: a1, global): A task to do.\n- Note (id: b2, session): A note.",
    );
  });

  it("introduces the list and names the data tools", () => {
    const text = schemasInstruction(schemas) ?? "";
    expect(text).toMatch(/^You have schemas:/);
    expect(text).toContain("data_list");
    expect(text.endsWith(schemasText(schemas))).toBe(true);
  });

  it("is nothing when no schema is in scope", () => {
    expect(schemasInstruction([])).toBeUndefined();
  });
});

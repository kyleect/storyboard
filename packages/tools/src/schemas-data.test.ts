import { describe, expect, it } from "vitest";
import { dataText, schemasText } from "./schemas-data.js";

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

  it("lists each schema with its name and description on one line", () => {
    expect(schemasText(schemas)).toBe("- Task: A task to do.\n- Note: A note.");
  });

  it("shows the scope only for a name that is in more than one scope", () => {
    expect(
      schemasText([
        ...schemas,
        {
          id: "c3",
          name: "Task",
          scope: "project" as const,
          description: "Mine.",
        },
      ]),
    ).toBe(
      "- Task (global): A task to do.\n- Note: A note.\n- Task (project): Mine.",
    );
  });

  it("is empty when no schema is in scope", () => {
    expect(schemasText([])).toBe("");
  });
});

describe("the data list", () => {
  it("lists each piece of data with its schema's name, its own name and its description on one line", () => {
    expect(
      dataText([
        { schema: "Task", name: "Chapter 1\nplan", description: "Plan\nit." },
        { schema: "Note", name: "Ideas", description: "" },
      ]),
    ).toBe("- Task: Chapter 1 plan - Plan it.\n- Note: Ideas");
  });

  it("is empty when there is no data", () => {
    expect(dataText([])).toBe("");
  });
});

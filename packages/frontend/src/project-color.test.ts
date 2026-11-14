import { describe, expect, it } from "vitest";
import { projectColorVar } from "./project-color";

describe("projectColorVar", () => {
  it("draws a color from the Mantine theme", () => {
    expect(projectColorVar("teal")).toBe("var(--mantine-color-teal-6)");
  });

  it("is undefined for a project without a color", () => {
    expect(projectColorVar(null)).toBeUndefined();
    expect(projectColorVar(undefined)).toBeUndefined();
  });
});

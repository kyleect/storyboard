import { describe, expect, it } from "vitest";
import { isProjectColor, PROJECT_COLORS } from "./project-colors.js";

describe("project colors", () => {
  it("has no repeats", () => {
    expect(new Set(PROJECT_COLORS).size).toBe(PROJECT_COLORS.length);
  });

  it("knows its own names and nothing else", () => {
    for (const color of PROJECT_COLORS)
      expect(isProjectColor(color)).toBe(true);
    expect(isProjectColor("chartreuse")).toBe(false);
    expect(isProjectColor("#ff0000")).toBe(false);
    expect(isProjectColor("")).toBe(false);
    expect(isProjectColor(null)).toBe(false);
    expect(isProjectColor(undefined)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { applySelection, changesBetween, pointerSteps } from "./changes.js";

describe("changesBetween (decisions 31, 32)", () => {
  it("lists changed, added and removed fields by path", () => {
    expect(
      changesBetween(
        { mood: "wary", hp: 12, notes: "x" },
        { mood: "hopeful", hp: 12, born: "2026-01-01" },
      ),
    ).toEqual([
      { path: "/mood", kind: "changed", before: "wary", after: "hopeful" },
      { path: "/notes", kind: "removed", before: "x" },
      { path: "/born", kind: "added", after: "2026-01-01" },
    ]);
  });

  it("compares lists by position, and fields inside items", () => {
    expect(
      changesBetween(
        { inv: [{ item: "knife", n: 1 }, "rope", "lantern"] },
        { inv: [{ item: "knife", n: 2 }, "lantern"] },
      ),
    ).toEqual([
      { path: "/inv/0/n", kind: "changed", before: 1, after: 2 },
      { path: "/inv/1", kind: "changed", before: "rope", after: "lantern" },
      { path: "/inv/2", kind: "removed", before: "lantern" },
    ]);
  });

  it("splits a new object into its fields", () => {
    expect(changesBetween(undefined, { a: 1, b: { c: 2 } })).toEqual([
      { path: "/a", kind: "added", after: 1 },
      { path: "/b/c", kind: "added", after: 2 },
    ]);
    expect(changesBetween(undefined, true)).toEqual([
      { path: "", kind: "added", after: true },
    ]);
  });

  it("escapes keys in paths", () => {
    expect(changesBetween({}, { "a/b~": 1 })[0]?.path).toBe("/a~1b~0");
    expect(pointerSteps("/a~1b~0/0")).toEqual(["a/b~", "0"]);
  });
});

describe("applySelection (decisions 32, 33)", () => {
  const before = { mood: "wary", hp: 12, inv: ["knife", "rope"], notes: "x" };
  const after = { mood: "hopeful", hp: 9, inv: ["knife"], born: "now" };

  it("applies only approved changes", () => {
    expect(applySelection(before, after, new Set(["/hp", "/born"]))).toEqual({
      mood: "wary",
      hp: 9,
      inv: ["knife", "rope"],
      notes: "x",
      born: "now",
    });
  });

  it("applies every change when all are approved", () => {
    const all = new Set(changesBetween(before, after).map((c) => c.path));
    expect(applySelection(before, after, all)).toEqual(after);
  });

  it("keeps an unapproved removal and drops an unapproved addition", () => {
    expect(applySelection(before, after, new Set())).toEqual(before);
    expect(
      applySelection(["a"], ["a", "b", "c"], new Set(["/inv", "/2"])),
    ).toEqual(["a", "c"]);
  });

  it("builds a new value from its approved fields only", () => {
    const value = { name: "T", value: { task: "a", priority: "low" } };
    expect(
      applySelection(undefined, value, new Set(["/name", "/value/task"])),
    ).toEqual({ name: "T", value: { task: "a" } });
    expect(applySelection(undefined, value, new Set())).toBeUndefined();
  });
});

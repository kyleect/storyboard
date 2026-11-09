import { describe, expect, it } from "vitest";
import {
  isCovered,
  normalizeTick,
  normalizeTicks,
  tickState,
  toggleTick,
} from "./workspace-ticks.js";

/* What is searched in a workspace: the set of ticked paths. */

/** A folder tree for `toggleTick`: folder path -> entry paths. */
const tree: Record<string, string[]> = {
  "": ["a", "b", "c.md"],
  a: ["a/x", "a/y.md"],
  "a/x": ["a/x/1.md", "a/x/2.md"],
  b: ["b/z.md"],
};
const children = (folder: string) => tree[folder] ?? [];

describe("normalizeTick", () => {
  it("cleans a path", () => {
    expect(normalizeTick("/a//b/")).toBe("a/b");
    expect(normalizeTick("./a/./b")).toBe("a/b");
    expect(normalizeTick("")).toBe("");
    expect(normalizeTick("/")).toBe("");
  });

  it("refuses a path that goes up", () => {
    expect(() => normalizeTick("a/../../x")).toThrow(/\.\./);
    expect(() => normalizeTick("..")).toThrow(/\.\./);
  });
});

describe("normalizeTicks", () => {
  it("drops duplicates and paths inside a ticked folder, and sorts", () => {
    expect(normalizeTicks(["b/z.md", "a", "a/x/1.md", "a", "b"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("the whole folder covers everything", () => {
    expect(normalizeTicks(["a", "", "b/z.md"])).toEqual([""]);
  });

  it("keeps a file beside a folder with a similar name", () => {
    expect(normalizeTicks(["a", "ab.md"])).toEqual(["a", "ab.md"]);
  });
});

describe("isCovered and tickState", () => {
  it("a path is covered by itself and by a ticked folder above it", () => {
    expect(isCovered(["a"], "a")).toBe(true);
    expect(isCovered(["a"], "a/x/1.md")).toBe(true);
    expect(isCovered(["a"], "ab")).toBe(false);
    expect(isCovered([""], "anything/at/all")).toBe(true);
    expect(isCovered([], "a")).toBe(false);
  });

  it("a folder is partly ticked when something inside it is", () => {
    expect(tickState(["a/x/1.md"], "a")).toBe("some");
    expect(tickState(["a/x/1.md"], "a/x")).toBe("some");
    expect(tickState(["a/x/1.md"], "a/x/1.md")).toBe("all");
    expect(tickState(["a/x/1.md"], "b")).toBe("none");
    expect(tickState(["a"], "a/x")).toBe("all");
  });
});

describe("toggleTick", () => {
  it("ticks a path and drops what was ticked inside it", () => {
    expect(toggleTick(["a/x/1.md"], "a", true, children)).toEqual(["a"]);
    expect(toggleTick([], "c.md", true, children)).toEqual(["c.md"]);
  });

  it("unticks a ticked path", () => {
    expect(toggleTick(["a", "b"], "a", false, children)).toEqual(["b"]);
  });

  it("unticking inside a ticked folder ticks the rest of it", () => {
    expect(toggleTick(["a"], "a/x/1.md", false, children)).toEqual([
      "a/x/2.md",
      "a/y.md",
    ]);
  });

  it("unticking inside the whole folder keeps everything else", () => {
    expect(toggleTick([""], "a/y.md", false, children)).toEqual([
      "a/x",
      "b",
      "c.md",
    ]);
  });

  it("unticking the whole folder leaves nothing", () => {
    expect(toggleTick([""], "", false, children)).toEqual([]);
  });

  it("unticking a partly ticked folder drops what is ticked inside it", () => {
    expect(toggleTick(["a/x/1.md", "b"], "a", false, children)).toEqual(["b"]);
  });

  it("unticking something that is not ticked changes nothing", () => {
    expect(toggleTick(["b"], "c.md", false, children)).toEqual(["b"]);
  });

  it("ticking back what was unticked gives the folder again", () => {
    const after = toggleTick(["a"], "a/x/1.md", false, children);
    expect(toggleTick(after, "a/x/1.md", true, children)).toEqual([
      "a/x/1.md",
      "a/x/2.md",
      "a/y.md",
    ]);
  });
});

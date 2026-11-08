import { describe, expect, it } from "vitest";
import { findRefs, formatRef, parseRef, plainRef } from "./file-refs.js";

describe("references (D5, D7, D34, D52)", () => {
  it("writes a reference in angle brackets and as plain text", () => {
    const ref = { location: "session", path: "My Photo.png" } as const;
    expect(formatRef(ref)).toBe("<session://My Photo.png>");
    expect(plainRef(ref)).toBe("session://My Photo.png");
    expect(
      formatRef({ location: "workspace", workspaceId: "w1", path: "a/b.md" }),
    ).toBe("<workspace://w1/a/b.md>");
  });

  it.each([
    ["session://notes.md", { location: "session", path: "notes.md" }],
    ["<session://notes.md>", { location: "session", path: "notes.md" }],
    [
      "project://characters/alice.md",
      { location: "project", path: "characters/alice.md" },
    ],
    ["global://My Photo é.png", { location: "global", path: "My Photo é.png" }],
    ["session://a#b?c.md", { location: "session", path: "a#b?c.md" }],
    [
      "workspace://w1/chapters/one.md",
      { location: "workspace", workspaceId: "w1", path: "chapters/one.md" },
    ],
    ["workspace://w1", { location: "workspace", workspaceId: "w1", path: "" }],
    ["workspace://w1/", { location: "workspace", workspaceId: "w1", path: "" }],
  ])("reads %j", (text, ref) => {
    expect(parseRef(text)).toEqual(ref);
  });

  it.each([
    "notes.md",
    "",
    "session://",
    "workspace://",
    "workspace:///a",
    "file://notes.md",
    "Session://notes.md",
    "see session://notes.md",
    "<session://a>b.md>",
  ])("does not read %j", (text) => {
    expect(parseRef(text)).toBeUndefined();
  });

  it("round trips a reference with spaces and Unicode", () => {
    const ref = { location: "project", path: "dir one/ファイル 2.md" } as const;
    expect(parseRef(formatRef(ref))).toEqual(ref);
    expect(parseRef(plainRef(ref))).toEqual(ref);
  });

  it("finds every bracketed reference in a text, in order", () => {
    const text =
      "Look at <session://a b.png> and <project://x/y.md>, not session://plain.md or <other://z>.";
    expect(findRefs(text)).toEqual([
      { location: "session", path: "a b.png" },
      { location: "project", path: "x/y.md" },
    ]);
    expect(findRefs("nothing here")).toEqual([]);
  });
});

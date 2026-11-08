import { describe, expect, it } from "vitest";
import {
  fileNameProblem,
  isInFolder,
  joinPath,
  MAX_NAME_LENGTH,
  parentFolders,
} from "./file-names.js";

describe("fileNameProblem (D50, D51)", () => {
  it.each([
    "a",
    "notes.md",
    "My Photo.png",
    "日本語.txt",
    "a/b/c.md",
    "Upper and lower",
    ".hidden",
    "a.b.c",
    "COM10",
    "concert.md",
  ])("accepts %j", (path) => {
    expect(fileNameProblem(path)).toBeUndefined();
  });

  it.each([
    ["", /empty/],
    ["a//b", /empty/],
    ["/a", /empty/],
    ["a/", /empty/],
    [".", /not allowed/],
    ["..", /not allowed/],
    ["a/../b", /not allowed/],
    ["a.", /end in a dot or a space/],
    ["a ", /end in a dot or a space/],
    ["a\u0000b", /control/],
    ["a\nb", /control/],
    ["a\u007fb", /control/],
    ["CON", /Windows/],
    ["con", /Windows/],
    ["NUL.txt", /Windows/],
    ["dir/COM1", /Windows/],
    ["LPT9.md", /Windows/],
    ["a".repeat(MAX_NAME_LENGTH + 1), /longer than 255/],
  ])("refuses %j", (path, why) => {
    expect(fileNameProblem(path)).toMatch(why);
  });

  it("allows exactly 255 characters in a name, counted as characters", () => {
    expect(fileNameProblem("a".repeat(MAX_NAME_LENGTH))).toBeUndefined();
    expect(fileNameProblem("é".repeat(MAX_NAME_LENGTH))).toBeUndefined();
    expect(fileNameProblem("😀".repeat(MAX_NAME_LENGTH))).toBeUndefined();
    expect(
      fileNameProblem(
        `${"a".repeat(MAX_NAME_LENGTH)}/${"b".repeat(MAX_NAME_LENGTH)}`,
      ),
    ).toBeUndefined();
  });

  it("keeps names exactly as typed: case differs, no normalisation", () => {
    expect(fileNameProblem("Readme.md")).toBeUndefined();
    expect(fileNameProblem("readme.md")).toBeUndefined();
    expect(fileNameProblem("é.md")).toBeUndefined();
  });
});

describe("path helpers", () => {
  it("lists the folders above a path, outermost first", () => {
    expect(parentFolders("a/b/c.md")).toEqual(["a", "a/b"]);
    expect(parentFolders("c.md")).toEqual([]);
  });

  it("joins a folder and a name; the top level is empty", () => {
    expect(joinPath("", "a.md")).toBe("a.md");
    expect(joinPath("x/y", "a.md")).toBe("x/y/a.md");
  });

  it("knows what is inside a folder, whole names only", () => {
    expect(isInFolder("a/b.md", "a")).toBe(true);
    expect(isInFolder("a", "a")).toBe(true);
    expect(isInFolder("ab/c.md", "a")).toBe(false);
  });
});

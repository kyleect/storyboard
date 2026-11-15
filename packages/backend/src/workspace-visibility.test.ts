import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGitignore,
  isHidden,
  visibilityOf,
} from "./workspace-visibility.js";

/* Which paths of a workspace are shown: .gitignore files and hidden paths. */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harness-vis-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, text = "x") => {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
};

describe("createGitignore", () => {
  it("ignores what the root .gitignore says, and nothing without one", () => {
    put("a.md");
    put("build/out.js");
    expect(createGitignore(root).ignored("build/out.js")).toBe(false);
    put(".gitignore", "build/\n*.log\n");
    const ig = createGitignore(root);

    expect(ig.ignored("build")).toBe(true);
    expect(ig.ignored("build/out.js")).toBe(true);
    expect(ig.ignored("deep/run.log")).toBe(true);
    expect(ig.ignored("a.md")).toBe(false);
    expect(ig.ignored(".gitignore")).toBe(false);
  });

  it("applies a nested .gitignore below its own folder only", () => {
    put(".gitignore", "*.tmp\n");
    put("sub/.gitignore", "secret.md\n");
    put("sub/secret.md");
    put("secret.md");
    const ig = createGitignore(root);

    expect(ig.ignored("sub/secret.md")).toBe(true);
    expect(ig.ignored("secret.md")).toBe(false);
    expect(ig.ignored("sub/x.tmp")).toBe(true);
  });

  it("lets a deeper file undo a higher one, and anchors patterns to their folder", () => {
    put(".gitignore", "*.md\n/top.txt\n");
    put("keep/.gitignore", "!*.md\n");
    put("keep/a.md");
    put("top.txt");
    put("sub/top.txt");
    const ig = createGitignore(root);

    expect(ig.ignored("a.md")).toBe(true);
    expect(ig.ignored("keep/a.md")).toBe(false);
    expect(ig.ignored("top.txt")).toBe(true);
    expect(ig.ignored("sub/top.txt")).toBe(false);
  });

  it("treats a folder-only pattern as a folder, not a file of that name", () => {
    put(".gitignore", "logs/\n");
    put("logs/a.txt");
    put("src/logs", "a file called logs");
    const ig = createGitignore(root);

    expect(ig.ignored("logs/a.txt")).toBe(true);
    expect(ig.ignored("src/logs")).toBe(false);
  });

  it("keeps an ignored folder's contents ignored even when a pattern re-includes them", () => {
    put(".gitignore", "build/\n!build/keep.md\n");
    put("build/keep.md");

    expect(createGitignore(root).ignored("build/keep.md")).toBe(true);
  });

  it("reads .git/info/exclude and always ignores .git", () => {
    put(".git/info/exclude", "scratch.md\n");
    put(".git/HEAD");
    put("scratch.md");
    put("pkg/.git/config");
    const ig = createGitignore(root);

    expect(ig.ignored("scratch.md")).toBe(true);
    expect(ig.ignored(".git/HEAD")).toBe(true);
    expect(ig.ignored("pkg/.git/config")).toBe(true);
  });
});

describe("isHidden and visibilityOf", () => {
  it("hides a path and what is inside it", () => {
    expect(isHidden(["notes"], "notes")).toBe(true);
    expect(isHidden(["notes"], "notes/a.md")).toBe(true);
    expect(isHidden(["notes"], "notes2/a.md")).toBe(false);
    expect(isHidden([], "a.md")).toBe(false);
  });

  it("shows a path that is neither ignored nor hidden", () => {
    put(".gitignore", "build/\n");
    const w = { path: root, respectGitignore: true };
    const shown = visibilityOf(w, ["private"]);

    expect(shown("a.md")).toBe(true);
    expect(shown("build/x.js")).toBe(false);
    expect(shown("private/x.md")).toBe(false);
  });

  it("does not look at .gitignore when the workspace does not respect it", () => {
    put(".gitignore", "build/\n");
    const shown = visibilityOf({ path: root, respectGitignore: false }, [
      "private",
    ]);

    expect(shown("build/x.js")).toBe(true);
    expect(shown("private/x.md")).toBe(false);
  });
});

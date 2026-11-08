import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceError,
  type WorkspaceAccess,
  type WorkspaceErrorCode,
} from "@harness/core";
import {
  classify,
  createWorkspaceAccess,
  resolveIn,
  workspaceMediaSource,
  type ReadRecord,
} from "./workspace-fs.js";
import type { AttachedWorkspace } from "./workspaces-store.js";

/* The disk layer of workspaces: safe paths, reads, writes and folders. */

let root: string;
let outside: string;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "harness-ws-"));
  root = join(base, "notes");
  outside = join(base, "secret");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "key.txt"), "TOP SECRET");
});
afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function setup(over: { writable?: boolean; cap?: number } = {}) {
  const ws: AttachedWorkspace = {
    id: "w1",
    name: "Notes",
    path: root,
    writable: over.writable ?? true,
    effectiveWritable: over.writable ?? true,
    createdAt: "t",
    updatedAt: "t",
    deleted: false,
  };
  const reads = new Map<string, ReadRecord>();
  const access = createWorkspaceAccess({
    attached: () => [ws],
    readCap: () => over.cap ?? 10_000,
    reads,
  });
  return { ws, reads, access };
}

async function code(p: Promise<unknown>): Promise<WorkspaceErrorCode> {
  try {
    await p;
  } catch (err) {
    if (err instanceof WorkspaceError) return err.code;
    throw err;
  }
  throw new Error("It did not fail.");
}

describe("resolveIn", () => {
  it("accepts paths inside the folder, existing or not", () => {
    expect(resolveIn(root, "a/b.md")).toBe(join(root, "a", "b.md"));
    expect(resolveIn(root, "")).toBe(root);
  });

  it("refuses .. and absolute paths", () => {
    expect(() => resolveIn(root, "../secret/key.txt")).toThrow(/outside/);
    expect(() => resolveIn(root, "a/../../secret")).toThrow(/outside/);
    expect(() => resolveIn(root, "/etc/passwd")).toThrow(/not a full path/);
  });

  it("refuses a symlink that leads out, for a file and for a folder", () => {
    symlinkSync(join(outside, "key.txt"), join(root, "link.txt"));
    symlinkSync(outside, join(root, "dir"));
    expect(() => resolveIn(root, "link.txt")).toThrow(/outside/);
    expect(() => resolveIn(root, "dir/key.txt")).toThrow(/outside/);
    // Also a new file made through the link.
    expect(() => resolveIn(root, "dir/new.txt")).toThrow(/outside/);
  });

  it("follows a symlink that stays inside", () => {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    expect(resolveIn(root, "alias/x.md")).toBe(join(root, "alias", "x.md"));
  });

  it("allows an outside path only when told to", () => {
    expect(resolveIn(root, "../secret/key.txt", true)).toBe(
      join(outside, "key.txt"),
    );
  });
});

describe("reading", () => {
  it("returns text with its length, and reads in parts with offset and limit", async () => {
    const { access } = setup({ cap: 100 });
    writeFileSync(join(root, "long.md"), "abcdefghij".repeat(30));
    const first = await access.read("w1", "long.md");
    expect(first).toMatchObject({
      kind: "text",
      mediaType: "text/markdown",
      offset: 0,
      total: 300,
    });
    expect(first.kind === "text" && first.text.length).toBe(100);
    const second = await access.read("w1", "long.md", {
      offset: 250,
      limit: 1000,
    });
    // The cap applies to the limit too.
    expect(second.kind === "text" && second.text.length).toBe(50);
    const mid = await access.read("w1", "long.md", { offset: 5, limit: 10 });
    expect(mid.kind === "text" && mid.text).toBe("fghijabcde");
  });

  it("counts characters, not bytes", async () => {
    const { access } = setup();
    writeFileSync(join(root, "u.txt"), "héllo wörld 😀");
    const r = await access.read("w1", "u.txt", { offset: 12, limit: 5 });
    expect(r).toMatchObject({ kind: "text", text: "😀", total: 13 });
  });

  it("tells media and binary files from text", async () => {
    const { access } = setup();
    writeFileSync(join(root, "p.png"), PNG);
    writeFileSync(join(root, "data.bin"), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(root, "bad.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
    expect(await access.read("w1", "p.png")).toMatchObject({
      kind: "media",
      mediaType: "image/png",
    });
    expect(await access.read("w1", "data.bin")).toMatchObject({
      kind: "binary",
    });
    expect(await access.read("w1", "bad.txt")).toMatchObject({
      kind: "binary",
    });
    // A text file named .png is not an image.
    writeFileSync(join(root, "fake.png"), "just words");
    expect(await access.read("w1", "fake.png")).toMatchObject({ kind: "text" });
  });

  it("refuses outside paths, folders and missing files", async () => {
    const { access } = setup();
    symlinkSync(outside, join(root, "dir"));
    mkdirSync(join(root, "sub"));
    expect(await code(access.read("w1", "dir/key.txt"))).toBe("outside");
    expect(await code(access.read("w1", "../secret/key.txt"))).toBe("outside");
    expect(await code(access.read("w1", "sub"))).toBe("invalid");
    expect(await code(access.read("w1", "nope.md"))).toBe("not_found");
    expect(await code(access.read("w9", "a.md"))).toBe("not_found");
  });

  it("reads an outside path once told to", async () => {
    const { access } = setup();
    const r = await access.read("w1", "../secret/key.txt", {
      allowOutside: true,
    });
    expect(r).toMatchObject({ kind: "text", text: "TOP SECRET" });
  });
});

describe("listing", () => {
  it("lists a folder, with hidden files, and goes down on request", async () => {
    const { access } = setup();
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(join(root, "top.md"), "x");
    writeFileSync(join(root, ".hidden"), "y");
    writeFileSync(join(root, "a/one.md"), "1");
    writeFileSync(join(root, "a/b/two.md"), "2");
    const flat = await access.listDir("w1", "");
    expect(flat.map((e) => `${e.kind}:${e.path}`)).toEqual([
      "file:.hidden",
      "folder:a",
      "file:top.md",
    ]);
    const deep = await access.listDir("w1", "", { recursive: true });
    expect(deep.map((e) => e.path)).toEqual([
      ".hidden",
      "a",
      "a/b",
      "a/b/two.md",
      "a/one.md",
      "top.md",
    ]);
    const sub = await access.listDir("w1", "a");
    expect(sub.map((e) => e.path)).toEqual(["a/b", "a/one.md"]);
  });

  it("does not go into a symlinked folder, and a link out cannot be listed", async () => {
    const { access } = setup();
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real/f.md"), "f");
    symlinkSync(join(root, "real"), join(root, "alias"));
    symlinkSync(outside, join(root, "out"));
    const deep = await access.listDir("w1", "", { recursive: true });
    expect(deep.map((e) => e.path)).toContain("alias");
    expect(deep.map((e) => e.path)).not.toContain("alias/f.md");
    expect(await code(access.listDir("w1", "out"))).toBe("outside");
  });
});

describe("writing", () => {
  it("creates a file and the folders on the way", async () => {
    const { access } = setup();
    const r = await access.write("w1", "new/deep/ch1.md", "# One");
    expect(r).toEqual({ created: true, size: 5 });
    expect(readFileSync(join(root, "new/deep/ch1.md"), "utf8")).toBe("# One");
  });

  it("refuses a read-only workspace and a bad name", async () => {
    const ro = setup({ writable: false });
    expect(await code(ro.access.write("w1", "a.md", "x"))).toBe("read_only");
    expect(await code(ro.access.remove("w1", "a.md"))).toBe("read_only");
    expect(await code(ro.access.createFolder("w1", "d"))).toBe("read_only");
    const { access } = setup();
    expect(await code(access.write("w1", "con.txt", "x"))).toBe("invalid");
    expect(await code(access.write("w1", "a/../../x.md", "x"))).toBe("outside");
    expect(await code(access.write("w1", "../secret/x.md", "x"))).toBe(
      "outside",
    );
    expect(existsSync(join(outside, "x.md"))).toBe(false);
  });

  it("never writes through a symlink that leads out", async () => {
    const { access } = setup();
    symlinkSync(join(outside, "key.txt"), join(root, "link.txt"));
    expect(await code(access.write("w1", "link.txt", "pwned"))).toBe("outside");
    expect(readFileSync(join(outside, "key.txt"), "utf8")).toBe("TOP SECRET");
  });

  it("writes an approved outside path", async () => {
    const { access } = setup();
    await access.write("w1", "../secret/new.txt", "ok", { allowOutside: true });
    expect(readFileSync(join(outside, "new.txt"), "utf8")).toBe("ok");
  });

  it("refuses to replace a file that was not read, then accepts it once read", async () => {
    const { access } = setup();
    writeFileSync(join(root, "a.md"), "old");
    expect(await code(access.write("w1", "a.md", "new"))).toBe("stale");
    await access.read("w1", "a.md");
    await access.write("w1", "a.md", "new");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("new");
    // Its own write counts as seen: a second write needs no new read.
    await access.write("w1", "a.md", "newer");
  });

  it("refuses a write or edit when the file changed since it was read (D32)", async () => {
    const { access } = setup();
    const file = join(root, "a.md");
    writeFileSync(file, "one two");
    await access.read("w1", "a.md");
    writeFileSync(file, "one two three");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(await code(access.write("w1", "a.md", "x"))).toBe("stale");
    expect(await code(access.edit("w1", "a.md", "one", "1"))).toBe("stale");
    expect(readFileSync(file, "utf8")).toBe("one two three");
    await access.read("w1", "a.md");
    await access.edit("w1", "a.md", "one", "1");
    expect(readFileSync(file, "utf8")).toBe("1 two three");
  });
});

describe("editing", () => {
  it("replaces exact text once, or all with replaceAll", async () => {
    const { access } = setup();
    writeFileSync(join(root, "a.md"), "cat dog cat");
    await access.read("w1", "a.md");
    expect(await code(access.edit("w1", "a.md", "cat", "cow"))).toBe("invalid");
    expect(await code(access.edit("w1", "a.md", "bird", "x"))).toBe("invalid");
    expect(await code(access.edit("w1", "a.md", "", "x"))).toBe("invalid");
    expect(await access.edit("w1", "a.md", "dog", "pig")).toEqual({
      replacements: 1,
    });
    expect(
      await access.edit("w1", "a.md", "cat", "cow", { replaceAll: true }),
    ).toEqual({ replacements: 2 });
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("cow pig cow");
  });

  it("refuses a missing or non-text file", async () => {
    const { access } = setup();
    writeFileSync(join(root, "p.png"), PNG);
    await access.read("w1", "p.png");
    expect(await code(access.edit("w1", "p.png", "a", "b"))).toBe("not_text");
    expect(await code(access.edit("w1", "gone.md", "a", "b"))).toBe(
      "not_found",
    );
  });
});

describe("moving and deleting", () => {
  it("moves a file, makes the folders, and never overwrites", async () => {
    const { access } = setup();
    writeFileSync(join(root, "a.md"), "A");
    writeFileSync(join(root, "b.md"), "B");
    await access.move("w1", "a.md", "x/y/a.md");
    expect(readFileSync(join(root, "x/y/a.md"), "utf8")).toBe("A");
    expect(await code(access.move("w1", "b.md", "x/y/a.md"))).toBe("exists");
    expect(await code(access.move("w1", "b.md", "../secret/b.md"))).toBe(
      "outside",
    );
    expect(await code(access.move("w1", "x", "z"))).toBe("invalid");
  });

  it("deletes a file, and refuses a folder", async () => {
    const { access } = setup();
    writeFileSync(join(root, "a.md"), "A");
    mkdirSync(join(root, "d"));
    await access.remove("w1", "a.md");
    expect(existsSync(join(root, "a.md"))).toBe(false);
    expect(await code(access.remove("w1", "d"))).toBe("invalid");
    expect(await code(access.remove("w1", "a.md"))).toBe("not_found");
  });

  it("removes a link, not what it points to", async () => {
    const { access } = setup();
    symlinkSync(join(root, "a.md"), join(root, "dangling"));
    await access.remove("w1", "dangling");
    expect(existsSync(join(root, "dangling"))).toBe(false);
  });
});

describe("folders", () => {
  it("creates, renames and deletes folders", async () => {
    const { access } = setup();
    expect(await access.createFolder("w1", "a/b")).toBe(true);
    expect(await access.createFolder("w1", "a/b")).toBe(false);
    writeFileSync(join(root, "a/b/f.md"), "f");
    await access.moveFolder("w1", "a", "c");
    expect(existsSync(join(root, "c/b/f.md"))).toBe(true);
    expect(await code(access.moveFolder("w1", "c", "c/b/in"))).toBe("invalid");
    expect(await code(access.deleteFolder("w1", "c"))).toBe("not_empty");
    expect(await access.deleteFolder("w1", "c", { recursive: true })).toEqual({
      files: 1,
    });
    expect(existsSync(join(root, "c"))).toBe(false);
  });

  it("deletes an empty folder without recursive, and never the root", async () => {
    const { access } = setup();
    mkdirSync(join(root, "empty"));
    expect(await access.deleteFolder("w1", "empty")).toEqual({ files: 0 });
    expect(await code(access.deleteFolder("w1", "", { recursive: true }))).toBe(
      "invalid",
    );
    expect(existsSync(root)).toBe(true);
    expect(
      await code(access.deleteFolder("w1", "../secret", { recursive: true })),
    ).toBe("outside");
    expect(existsSync(outside)).toBe(true);
  });

  it("does not follow a symlinked folder when deleting", async () => {
    const { access } = setup();
    mkdirSync(join(root, "d"));
    symlinkSync(outside, join(root, "d/out"));
    await access.deleteFolder("w1", "d", { recursive: true });
    expect(existsSync(join(outside, "key.txt"))).toBe(true);
  });
});

describe("locate", () => {
  it("reads references, and a plain path when there is one workspace", () => {
    const { access } = setup();
    expect(access.locate("workspace://w1/a/b.md")).toMatchObject({
      workspace: { id: "w1" },
      path: "a/b.md",
    });
    expect(access.locate("<workspace://w1/>")).toMatchObject({ path: "" });
    expect(access.locate("a/b.md")).toMatchObject({ path: "a/b.md" });
    expect(access.locate("workspace://zz/a")).toHaveProperty("error");
    expect(access.locate("session://a.md")).toHaveProperty("error");
  });

  it("wants a reference when there are several workspaces", () => {
    const { ws } = setup();
    const two = createWorkspaceAccess({
      attached: () => [ws, { ...ws, id: "w2", name: "Other" }],
      readCap: () => 10,
      reads: new Map(),
    }) satisfies WorkspaceAccess;
    expect(two.locate("a.md")).toHaveProperty("error");
    expect(two.locate("workspace://w2/a.md")).toMatchObject({
      workspace: { id: "w2" },
    });
  });
});

describe("classify and media source", () => {
  it("classifies by content", () => {
    expect(classify("a.md", Buffer.from("# hi"))).toEqual({
      kind: "text",
      mediaType: "text/markdown",
    });
    expect(classify("a.json", Buffer.from("{}"))).toEqual({
      kind: "text",
      mediaType: "application/json",
    });
    expect(classify("a", Buffer.from("x"))).toEqual({
      kind: "text",
      mediaType: "text/plain",
    });
  });

  it("serves only images and audio that are inside the folder", () => {
    const { ws } = setup();
    writeFileSync(join(root, "p.png"), PNG);
    writeFileSync(join(root, "n.md"), "x");
    symlinkSync(join(outside, "key.txt"), join(root, "out.png"));
    const source = workspaceMediaSource(() => [ws]);
    expect(source("w1", "p.png")?.mediaType).toBe("image/png");
    expect(source("w1", "p.png")?.bytes()?.equals(PNG)).toBe(true);
    expect(source("w1", "n.md")).toBeUndefined();
    expect(source("w1", "out.png")).toBeUndefined();
    expect(source("w1", "../secret/key.txt")).toBeUndefined();
    expect(source("w9", "p.png")).toBeUndefined();
    // A file with an image name that is not an image has no bytes to give.
    writeFileSync(join(root, "fake.png"), "words");
    expect(source("w1", "fake.png")?.bytes()).toBeUndefined();
  });
});

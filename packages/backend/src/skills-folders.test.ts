import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkillFile, parseSkillFile } from "./skill-frontmatter.js";
import { readSkillZip, symlinkNames, writeSkillZip } from "./skill-zip.js";
import { runDataSteps } from "./data-steps.js";
import { sweepBlobs } from "./blobs.js";
import {
  BINARY_CONTENTS_KEPT,
  DEFAULT_SKILL_LIMITS,
  SkillStore,
  type SkillLimits,
  type SkillOwner,
} from "./skills-store.js";
import { Store } from "./store.js";
import { clearBuiltins, tempDatabase } from "./test-helpers.js";

/*
 * Skills as folders (skills folders design): files, versions as manifests,
 * renames, pruning, caps, the data step and zip import and export.
 */

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const GLOBAL: SkillOwner = { scope: "global" };
const buf = (s: string) => Buffer.from(s, "utf-8");
const skillMd = (name = "my-skill", body = "Do it.") =>
  buf(buildSkillFile(name, "Use when testing.", body));

function setup(limits: Partial<SkillLimits> = {}) {
  const t = tempDatabase();
  clearBuiltins(t.db);
  cleanups.push(t.cleanup);
  const skills = new SkillStore(t.db, undefined, undefined, () => ({
    ...DEFAULT_SKILL_LIMITS,
    ...limits,
  }));
  return { db: t.db, skills };
}

const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, n, n, n]);

describe("files in a skill folder", () => {
  it("makes a skill from files and reads them back", () => {
    const { skills } = setup();
    const s = skills.createFromFiles(GLOBAL, [
      { path: "SKILL.md", data: skillMd() },
      { path: "refs/guide.md", data: buf("# Guide") },
      { path: "logo.png", data: png(1) },
    ]);
    expect(s).toMatchObject({ name: "my-skill", version: 1 });
    expect(skills.files(s.id).map((f) => f.path)).toEqual([
      "SKILL.md",
      "logo.png",
      "refs/guide.md",
    ]);
    expect(skills.readFile(s.id, "refs/guide.md")?.data?.toString()).toBe(
      "# Guide",
    );
    expect(skills.readFile(s.id, "nope.md")).toBeUndefined();
  });

  it("needs a SKILL.md with a valid frontmatter, and blocks saving a bad one", () => {
    const { skills } = setup();
    expect(() =>
      skills.createFromFiles(GLOBAL, [{ path: "a.md", data: buf("x") }]),
    ).toThrow(/SKILL\.md/);
    expect(() =>
      skills.createFromFiles(GLOBAL, [
        { path: "SKILL.md", data: buf("no frontmatter") },
      ]),
    ).toThrow(/---/);
    const s = skills.createFromFiles(GLOBAL, [
      { path: "SKILL.md", data: skillMd() },
    ]);
    expect(() =>
      skills.writeFile(s.id, "SKILL.md", buf("---\nname: other\n---\n")),
    ).toThrow();
    // The name in SKILL.md must stay the folder's name.
    expect(() => skills.writeFile(s.id, "SKILL.md", skillMd("other"))).toThrow(
      /name/i,
    );
    expect(skills.get(s.id)?.version).toBe(1);
  });

  it("writes, moves and removes files as new versions", () => {
    const { skills } = setup();
    const s = skills.createFromFiles(GLOBAL, [
      { path: "SKILL.md", data: skillMd() },
    ]);
    skills.writeFile(s.id, "notes.txt", buf("one"));
    skills.move(s.id, "notes.txt", "docs/notes.txt");
    expect(skills.files(s.id).map((f) => f.path)).toEqual([
      "SKILL.md",
      "docs/notes.txt",
    ]);
    skills.removePath(s.id, "docs/notes.txt");
    expect(skills.files(s.id).map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(skills.get(s.id)?.version).toBe(4);
    // An older version still has the file.
    expect(skills.files(s.id, 3).map((f) => f.path)).toContain(
      "docs/notes.txt",
    );
    expect(() => skills.removePath(s.id, "SKILL.md")).toThrow();
  });

  it("renames the folder and rewrites only the name line", () => {
    const { skills } = setup();
    const text =
      "---\nname: my-skill\ndescription: Use when testing.\nlicense: MIT\nmetadata:\n  x: 1\n---\n\nBody.";
    const s = skills.createFromFiles(GLOBAL, [
      { path: "SKILL.md", data: buf(text) },
    ]);
    const r = skills.rename(s.id, "better-name");
    expect(r).toMatchObject({ name: "better-name", version: 2 });
    expect(skills.skillFileText(s.id)).toBe(
      text.replace("name: my-skill", "name: better-name"),
    );
    skills.create(GLOBAL, {
      name: "taken",
      description: "d",
      body: "",
    });
    expect(() => skills.rename(s.id, "taken")).toThrow(/already exists/);
    expect(() => skills.rename(s.id, "Bad Name")).toThrow();
  });

  it("restores an older version under the current name without renaming", () => {
    const { skills } = setup();
    const s = skills.create(GLOBAL, {
      name: "first",
      description: "d",
      body: "Old.",
    });
    skills.rename(s.id, "second");
    skills.updateText(s.id, { description: "d", body: "New." });
    const back = skills.restore(s.id, 1);
    expect(back.name).toBe("second");
    expect(skills.skillFileText(s.id)).toContain("name: second");
    expect(skills.skillFileText(s.id)).toContain("Old.");
    // The version history keeps the names it had.
    expect(skills.versions(s.id).map((v) => v.name)).toEqual([
      "first",
      "second",
      "second",
      "second",
    ]);
  });

  it("keeps every other frontmatter key when saving the simple form", () => {
    const { skills } = setup();
    const s = skills.createFromFiles(GLOBAL, [
      {
        path: "SKILL.md",
        data: buf(
          "---\nname: my-skill\ndescription: d\nlicense: MIT\n---\n\nBody.",
        ),
      },
    ]);
    skills.updateText(s.id, { description: "new", body: "Changed." });
    const text = skills.skillFileText(s.id);
    expect(text).toContain("license: MIT");
    expect(text).toContain("description: new");
    expect(text).toContain("Changed.");
  });
});

describe("caps (decision 11)", () => {
  it("refuses a file, a skill and a count over the limits", () => {
    const { skills } = setup({ fileBytes: 100, skillBytes: 250, files: 3 });
    const base = [{ path: "SKILL.md", data: skillMd() }];
    expect(() =>
      skills.createFromFiles(GLOBAL, [
        ...base,
        { path: "big.bin", data: Buffer.alloc(101) },
      ]),
    ).toThrow(/the most for one file is 100 bytes/);
    expect(() =>
      skills.createFromFiles(GLOBAL, [
        ...base,
        { path: "a.bin", data: Buffer.alloc(90) },
        { path: "b.bin", data: Buffer.alloc(90) },
        { path: "c.bin", data: Buffer.alloc(90) },
      ]),
    ).toThrow();
    expect(() =>
      skills.createFromFiles(GLOBAL, [
        ...base,
        { path: "1.md", data: buf("1") },
        { path: "2.md", data: buf("2") },
        { path: "3.md", data: buf("3") },
      ]),
    ).toThrow(/more than 3|3 files/);
  });
});

describe("binary retention (decision 10)", () => {
  it("keeps the last three contents of a binary file, older versions show it missing", () => {
    const { skills, db } = setup();
    const s = skills.createFromFiles(GLOBAL, [
      { path: "SKILL.md", data: skillMd() },
      { path: "logo.png", data: png(1) },
    ]);
    for (let n = 2; n <= BINARY_CONTENTS_KEPT + 2; n++) {
      skills.writeFile(s.id, "logo.png", png(n));
    }
    // Contents 1 and 2 are gone; 3, 4 and 5 remain.
    const missing = (seq: number) =>
      skills.files(s.id, seq).find((f) => f.path === "logo.png")?.missing;
    expect(missing(1)).toBe(true);
    expect(missing(2)).toBe(true);
    expect(missing(3)).toBe(false);
    expect(missing(5)).toBe(false);
    expect(skills.readFile(s.id, "logo.png", 1)?.data).toBeNull();
    expect(skills.readFile(s.id, "logo.png")?.data).toEqual(png(5));
    // Text files are never pruned.
    expect(skills.readFile(s.id, "SKILL.md", 1)?.data).not.toBeNull();
    // The blobs of kept contents survive a sweep; pruned ones are not needed.
    sweepBlobs(db);
    expect(skills.readFile(s.id, "logo.png")?.data).toEqual(png(5));
  });

  it("restores a version whose binary is missing, still showing it missing", () => {
    const { skills } = setup();
    const s = skills.createFromFiles(GLOBAL, [
      { path: "SKILL.md", data: skillMd() },
      { path: "logo.png", data: png(1) },
    ]);
    for (let n = 2; n <= 5; n++) skills.writeFile(s.id, "logo.png", png(n));
    const back = skills.restore(s.id, 1);
    const logo = skills.files(back.id).find((f) => f.path === "logo.png");
    expect(logo?.missing).toBe(true);
  });
});

describe("skills-to-folders data step", () => {
  it("turns every old version into a SKILL.md, built-ins included", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const db = t.db;
    // An old-style skill with two versions and no files.
    db.prepare(
      `INSERT INTO skills (id, project_id, agent_id, display_name, name, description, body, version, created_at, updated_at)
       VALUES ('old', NULL, NULL, 'Old One', 'old-one', 'Newest.', 'Body 2', 2, 'T', 'T')`,
    ).run();
    for (const [seq, description, body] of [
      [1, "First: one", "Body 1"],
      [2, "Newest.", "Body 2"],
    ] as const) {
      db.prepare(
        `INSERT INTO skill_versions (skill_id, seq, display_name, name, description, body, deleted, created_at)
         VALUES ('old', ?, 'Old One', 'old-one', ?, ?, 0, 'T')`,
      ).run(seq, description, body);
    }
    runDataSteps(db, undefined, () => "T");
    const skills = new SkillStore(db);
    // The colon forces quoting; whichever quotes YAML picks, it must parse back.
    expect(parseSkillFile(skills.skillFileText("old", 1)).description).toBe(
      "First: one",
    );
    expect(skills.skillFileText("old", 1)).toContain("name: old-one");
    expect(skills.skillFileText("old", 2)).toContain("Body 2");
    // Built-in skills are converted too.
    const builtin = skills.builtins()[0];
    expect(builtin).toBeDefined();
    expect(skills.skillFileText(builtin?.id ?? "").length).toBeGreaterThan(20);
    // A second run changes nothing.
    expect(runDataSteps(db)).toEqual([]);
  });
});

describe("deleting and purging", () => {
  it("purging a project removes its skills' files", () => {
    const { skills, db } = setup();
    const store = new Store(db);
    store.createProject({ id: "p", name: "P", description: "", now: "T" });
    const s = skills.createFromFiles({ scope: "project", id: "p" }, [
      { path: "SKILL.md", data: skillMd() },
    ]);
    expect(skills.files(s.id)).toHaveLength(1);
    store.purgeProject("p");
    const left = db.prepare("SELECT COUNT(*) AS n FROM skill_files").get() as {
      n: number;
    };
    expect(left.n).toBe(0);
  });
});

describe("skill zips (decisions 15, 17, 18)", () => {
  const limits = DEFAULT_SKILL_LIMITS;
  const zip = (entries: Record<string, string | Uint8Array>) =>
    Buffer.from(
      zipSync(
        Object.fromEntries(
          Object.entries(entries).map(([k, v]) => [
            k,
            typeof v === "string" ? strToU8(v) : v,
          ]),
        ),
      ),
    );

  it("reads files at the top level", () => {
    const r = readSkillZip(
      zip({ "SKILL.md": skillMd().toString(), "a/b.md": "x" }),
      limits,
    );
    expect(r.folder).toBeNull();
    expect(r.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "a/b.md"]);
  });

  it("strips one wrapping folder", () => {
    const r = readSkillZip(
      zip({ "my-skill/SKILL.md": skillMd().toString(), "my-skill/r.md": "x" }),
      limits,
    );
    expect(r.folder).toBe("my-skill");
    expect(r.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "r.md"]);
  });

  it("round-trips through writeSkillZip", () => {
    const files = [
      { path: "SKILL.md", data: skillMd() },
      { path: "refs/g.md", data: buf("guide") },
    ];
    const out = readSkillZip(writeSkillZip("my-skill", files), limits);
    expect(out.folder).toBe("my-skill");
    expect(out.files.map((f) => [f.path, f.data.toString()]).sort()).toEqual([
      ["SKILL.md", skillMd().toString()],
      ["refs/g.md", "guide"],
    ]);
  });

  it("skips junk entries", () => {
    const r = readSkillZip(
      zip({
        "SKILL.md": skillMd().toString(),
        "__MACOSX/._SKILL.md": "junk",
        ".DS_Store": "junk",
      }),
      limits,
    );
    expect(r.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  it("refuses paths that leave the folder", () => {
    for (const name of ["../evil.md", "/abs.md", "a/../../b.md", "a\\b.md"]) {
      expect(() =>
        readSkillZip(
          zip({ "SKILL.md": skillMd().toString(), [name]: "x" }),
          limits,
        ),
      ).toThrow(/cannot be used/);
    }
  });

  it("refuses a zip with no SKILL.md, no files, or not a zip", () => {
    expect(() => readSkillZip(zip({ "a.md": "x" }), limits)).toThrow(
      /no SKILL\.md/,
    );
    expect(() => readSkillZip(Buffer.from("not a zip"), limits)).toThrow();
    expect(() => readSkillZip(Buffer.alloc(0), limits)).toThrow();
  });

  it("counts the bytes really inflated, not the sizes the archive claims", () => {
    // A highly compressible file: tiny in the archive, large inflated.
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const archive = zip({
      "SKILL.md": skillMd().toString(),
      "big.txt": big,
    });
    expect(archive.length).toBeLessThan(100 * 1024);
    expect(() =>
      readSkillZip(archive, { ...limits, fileBytes: 1024 * 1024 }),
    ).toThrow(/limit for one file/);
    expect(() =>
      readSkillZip(archive, { ...limits, skillBytes: 1024 * 1024 }),
    ).toThrow(/in all/);
    expect(() => readSkillZip(archive, { ...limits, files: 1 })).toThrow(
      /more than 1/,
    );
  });

  it("leaves out symbolic links and says so", () => {
    // Build an archive, then mark one entry as a Unix symlink in its central
    // directory (made-by Unix, mode 0120777).
    const archive = zip({
      "SKILL.md": skillMd().toString(),
      "link.md": "target.md",
    });
    const bytes = new Uint8Array(archive);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        at = dv.getUint32(i + 16, true);
        break;
      }
    }
    const count = 2;
    for (let n = 0; n < count; n++) {
      const nameLength = dv.getUint16(at + 28, true);
      const name = Buffer.from(
        bytes.subarray(at + 46, at + 46 + nameLength),
      ).toString();
      if (name === "link.md") {
        dv.setUint16(at + 4, (3 << 8) | 20, true);
        dv.setUint32(at + 38, (0o120777 << 16) >>> 0, true);
      }
      at +=
        46 +
        nameLength +
        dv.getUint16(at + 30, true) +
        dv.getUint16(at + 32, true);
    }
    const marked = Buffer.from(bytes);
    expect([...symlinkNames(marked)]).toEqual(["link.md"]);
    const r = readSkillZip(marked, limits);
    expect(r.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(r.warnings.join(" ")).toMatch(/link\.md.*symbolic link/);
  });
});

import { Unzip, UnzipInflate, zipSync } from "fflate";
import { fileNameProblem } from "@harness/core";
import {
  mib,
  SkillError,
  type SkillFileInput,
  type SkillLimits,
} from "./skills-store.js";

/*
 * Skills in and out as zip files (skills folders design, decisions 15, 17,
 * 18). A skill zip holds the skill's folder: either the files at the top
 * level, or one folder (named for the skill) that holds them, as other
 * harnesses write it. Archives are untrusted: entries are read as a stream so
 * the caps count what is really inflated, not what the archive says, and a
 * path that could leave the folder is refused.
 */

export interface ReadSkillZip {
  files: SkillFileInput[];
  /** Entries that were left out, and why. */
  warnings: string[];
  /** The top-level folder the files were in, when they were in one. */
  folder: string | null;
}

const bad = (message: string, status = 400) => new SkillError(message, status);

/** Why an entry's path cannot be used, or undefined when it can. */
function unsafePath(name: string): string | undefined {
  if (name.includes("\\")) return "it has a backslash in its path";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    return "its path is absolute";
  }
  const parts = name.split("/");
  if (parts.some((p) => p === ".." || p === ".")) {
    return "its path goes outside the folder";
  }
  const problem = fileNameProblem(name);
  return problem ? `its name is not valid (${problem})` : undefined;
}

const u16 = (b: Uint8Array, at: number) =>
  (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, at: number) =>
  ((b[at] ?? 0) |
    ((b[at + 1] ?? 0) << 8) |
    ((b[at + 2] ?? 0) << 16) |
    ((b[at + 3] ?? 0) << 24)) >>>
  0;

/**
 * The names of the entries the archive marks as symbolic links, from its
 * central directory (a link is an entry whose content is the link's target,
 * so it is never kept). Empty when the directory cannot be read.
 */
export function symlinkNames(zip: Uint8Array): Set<string> {
  const links = new Set<string>();
  // The end-of-central-directory record is in the last 64 KiB.
  let end = -1;
  for (
    let i = zip.length - 22;
    i >= Math.max(0, zip.length - 22 - 65535);
    i--
  ) {
    if (u32(zip, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return links;
  let at = u32(zip, end + 16);
  const count = u16(zip, end + 10);
  const decoder = new TextDecoder();
  for (let n = 0; n < count && u32(zip, at) === 0x02014b50; n++) {
    const madeBy = u16(zip, at + 4) >> 8;
    const attrs = u32(zip, at + 38);
    const nameLength = u16(zip, at + 28);
    const extraLength = u16(zip, at + 30);
    const commentLength = u16(zip, at + 32);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    // Made on Unix (3): the high 16 bits of the attributes are the file mode.
    if (madeBy === 3 && ((attrs >>> 16) & 0o170000) === 0o120000) {
      links.add(name);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return links;
}

/**
 * The files of a skill zip. Throws `SkillError` (400) for an archive that is
 * not a zip, holds a path that could leave the folder, or is over the caps;
 * the message says which.
 */
export function readSkillZip(zip: Buffer, limits: SkillLimits): ReadSkillZip {
  const links = symlinkNames(zip);
  const warnings: string[] = [];
  const found: { name: string; chunks: Uint8Array[]; size: number }[] = [];
  let failure: SkillError | undefined;
  let total = 0;
  const fail = (e: SkillError) => {
    failure ??= e;
  };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (failure) return;
    if (file.name.endsWith("/")) return; // a folder: its files carry the path
    if (links.has(file.name)) {
      warnings.push(`Left out "${file.name}": it is a symbolic link.`);
      return;
    }
    if (file.name.startsWith("__MACOSX/") || file.name.endsWith(".DS_Store")) {
      return;
    }
    const why = unsafePath(file.name);
    if (why) {
      fail(bad(`The zip holds "${file.name}", which cannot be used: ${why}.`));
      return;
    }
    if (found.length >= limits.files) {
      fail(bad(`The zip holds more than ${limits.files} files.`, 413));
      return;
    }
    const entry = { name: file.name, chunks: [] as Uint8Array[], size: 0 };
    found.push(entry);
    file.ondata = (err, chunk) => {
      if (failure) return;
      if (err) {
        fail(
          bad(`"${file.name}" could not be read from the zip: ${err.message}`),
        );
        return;
      }
      entry.size += chunk.length;
      total += chunk.length;
      if (entry.size > limits.fileBytes) {
        fail(
          bad(
            `"${file.name}" is over the ${mib(limits.fileBytes)} limit for one file.`,
            413,
          ),
        );
        file.terminate();
      } else if (total > limits.skillBytes) {
        fail(bad(`The zip holds over ${mib(limits.skillBytes)} in all.`, 413));
        file.terminate();
      } else {
        entry.chunks.push(chunk);
      }
    };
    file.start();
  };
  try {
    unzip.push(new Uint8Array(zip), true);
  } catch (err) {
    if (!failure) {
      fail(
        bad(
          `That is not a zip file that can be read: ${(err as Error).message}`,
        ),
      );
    }
  }
  if (failure) throw failure;

  const names = found.map((f) => f.name);
  if (names.length === 0) throw bad("The zip has no files in it.");
  // One folder that holds everything is the skill's folder.
  const tops = new Set(names.map((n) => n.split("/")[0]));
  const wrapped =
    !names.includes("SKILL.md") &&
    tops.size === 1 &&
    names.every((n) => n.includes("/"));
  const folder = wrapped ? (names[0]?.split("/")[0] ?? null) : null;
  const files = found.map((f): SkillFileInput => {
    const data = Buffer.concat(f.chunks);
    return {
      path: folder ? f.name.slice(folder.length + 1) : f.name,
      data,
    };
  });
  if (!files.some((f) => f.path === "SKILL.md")) {
    throw bad(
      "The zip has no SKILL.md at its top level or in its one top-level folder.",
    );
  }
  return { files, warnings, folder };
}

/**
 * A zip of a skill's folder: one top-level folder named for the skill, the
 * files as they are (decision 18).
 */
export function writeSkillZip(
  name: string,
  files: { path: string; data: Buffer }[],
): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[`${name}/${f.path}`] = new Uint8Array(f.data);
  return Buffer.from(zipSync(entries, { level: 6, mtime: new Date() }));
}

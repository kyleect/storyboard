import { zipSync } from "fflate";

/*
 * A folder the person picked, as a zip the backend can import. The browser
 * gives each file of a picked folder with its path from the folder's parent
 * (`webkitRelativePath`), so the zip has the folder at its top, as a skill
 * zip from another harness does.
 */

/** Names the OS adds that are not part of a skill. */
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db)$/;

/** The files as a zip, keeping each file's path inside the picked folder. */
export async function zipPickedFolder(files: readonly File[]): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    const path = f.webkitRelativePath || f.name;
    if (JUNK.test(path)) continue;
    entries[path] = new Uint8Array(await f.arrayBuffer());
  }
  if (Object.keys(entries).length === 0) {
    throw new Error("That folder has no files in it.");
  }
  return new Blob([zipSync(entries)], { type: "application/zip" });
}

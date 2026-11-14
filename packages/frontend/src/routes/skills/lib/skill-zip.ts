import { zipSync } from "fflate";

const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db)$/;

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

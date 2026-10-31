import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/*
 * The API token front ends send to the backend. It is kept in an owner-only
 * file so it stays the same across backend restarts: an open page and the
 * printed link keep working, and a second front end can find it (design doc,
 * "One shared backend": the token cannot be generated fresh at every launch).
 * Delete the file to get a new token.
 */
export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `Token file ${file} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 "${file}"`,
      );
    }
    const token = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
    throw new Error(
      `Token file ${file} does not contain a 64-character hex token. Delete it to create a new one.`,
    );
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, token + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return token;
}

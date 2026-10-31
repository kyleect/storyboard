import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./test-helpers.js";
import { loadOrCreateToken } from "./token.js";

let cleanup: () => void = () => {};
afterEach(() => cleanup());

function file() {
  const t = tempDir();
  cleanup = t.cleanup;
  return join(t.dir, "sub", "api.token");
}

describe("loadOrCreateToken", () => {
  it("creates an owner-only token once and returns the same one after", () => {
    const f = file();
    const token = loadOrCreateToken(f);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(f)).toBe(token);
  });

  it("refuses a token file other users can read", () => {
    const f = file();
    loadOrCreateToken(f);
    chmodSync(f, 0o644);
    expect(() => loadOrCreateToken(f)).toThrow(/chmod 600/);
  });

  it("refuses a token file with the wrong contents", () => {
    const f = file();
    loadOrCreateToken(f);
    writeFileSync(f, "nope");
    expect(() => loadOrCreateToken(f)).toThrow(/Delete it/);
  });
});

import { describe, expect, it } from "vitest";
import {
  formatEnv,
  formatHeaders,
  formatLines,
  parseEnv,
  parseHeaders,
  parseLines,
} from "./mcp-form";

describe("MCP form fields", () => {
  it("reads one argument per line and skips blank lines", () => {
    expect(parseLines("-y\n\n  @scope/server \r\n--flag")).toEqual([
      "-y",
      "@scope/server",
      "--flag",
    ]);
    expect(parseLines("")).toEqual([]);
  });

  it("reads NAME=value lines, keeping any '=' in the value", () => {
    expect(parseEnv("TOKEN=a=b\n KEY = v ")).toEqual({
      TOKEN: "a=b",
      KEY: "v",
    });
    expect(parseEnv("EMPTY=")).toEqual({ EMPTY: "" });
  });

  it("reads Name: value lines, keeping any ':' in the value", () => {
    expect(
      parseHeaders("Authorization: Bearer x\nX-Url: https://a.b/c"),
    ).toEqual({ Authorization: "Bearer x", "X-Url": "https://a.b/c" });
  });

  it("refuses a line without a name or separator", () => {
    expect(() => parseEnv("novalue")).toThrow(/NAME=value/);
    expect(() => parseEnv("=v")).toThrow(/NAME=value/);
    expect(() => parseHeaders("no colon")).toThrow(/Name: value/);
  });

  it("writes what it reads", () => {
    expect(parseLines(formatLines(["a", "b"]))).toEqual(["a", "b"]);
    expect(parseEnv(formatEnv({ A: "1", B: "x=y" }))).toEqual({
      A: "1",
      B: "x=y",
    });
    expect(parseHeaders(formatHeaders({ H: "v:w" }))).toEqual({ H: "v:w" });
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Message } from "./messages.js";
import {
  defineTool,
  errorCauses,
  latestToolState,
  serializeResult,
  ToolDefinitionError,
  ToolError,
  ToolRunError,
  truncate,
} from "./tools.js";

const base = {
  name: "t",
  description: "A test tool.",
  approval: "never" as const,
  execute: () => ({ data: null }),
};

describe("defineTool", () => {
  it("generates the JSON Schema without $schema", () => {
    const tool = defineTool({
      ...base,
      input: z.object({ text: z.string(), n: z.int().min(1).max(10) }),
    });
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        n: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["text", "n"],
      additionalProperties: false,
    });
  });

  it("refuses integers without both bounds, naming each field", () => {
    expect(() =>
      defineTool({
        ...base,
        input: z.object({
          a: z.number().int(),
          b: z.int().min(0),
          ok: z.int().min(0).max(5),
          list: z.array(z.int().max(3)),
          nested: z.object({ c: z.int().optional() }),
        }),
      }),
    ).toThrow(
      new ToolDefinitionError(
        'Tool "t": integer fields need both .min() and .max() (tools design 6.2): input.a, input.b, input.list.items, input.nested.c',
      ),
    );
  });

  it("refuses an input that is not an object, and bad names", () => {
    expect(() => defineTool({ ...base, input: z.string() })).toThrow(
      /must be an object/,
    );
    expect(() =>
      defineTool({ ...base, name: "has space", input: z.object({}) }),
    ).toThrow(/Tool name/);
  });

  it("checks arguments with the schema", () => {
    const tool = defineTool({
      ...base,
      input: z.object({ n: z.int().min(1).max(3) }),
    });
    expect(tool.parse({ n: 2 })).toEqual({ ok: true, input: { n: 2 } });
    const bad = tool.parse({ n: 9 });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/n/);
  });
});

describe("serializeResult", () => {
  it("keeps strings and writes everything else as JSON", () => {
    expect(serializeResult("plain")).toBe("plain");
    expect(serializeResult({ a: 1 })).toBe('{"a":1}');
    expect(serializeResult(3)).toBe("3");
    expect(serializeResult(undefined)).toBe("");
  });
});

describe("latestToolState", () => {
  const result = (name: string, state?: unknown): Message => ({
    role: "tool",
    callId: "c",
    name,
    content: "",
    isError: false,
    ...(state !== undefined ? { state } : {}),
  });

  it("finds the tool's latest saved state, ignoring other tools", () => {
    const messages = [
      result("a", 1),
      result("b", "other"),
      result("a", 2),
      result("a"),
      result("b", "latest other"),
    ];
    expect(latestToolState(messages, "a")).toBe(2);
    expect(latestToolState(messages, "c")).toBeUndefined();
  });
});

describe("truncate", () => {
  it("cuts long text and says how much was cut", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abcdef", 2)).toBe("ab… [4 more characters]");
  });
});

describe("errorCauses", () => {
  it("lists the cause chain, outermost first, with Node error codes", () => {
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND x.test"), {
      code: "ENOTFOUND",
    });
    const err = new TypeError("fetch failed", { cause: dns });
    expect(errorCauses(err)).toEqual([
      {
        name: "Error",
        message: "getaddrinfo ENOTFOUND x.test",
        code: "ENOTFOUND",
      },
    ]);
  });

  it("handles a non-error cause, no cause and a cycle", () => {
    expect(errorCauses(new Error("a", { cause: "text" }))).toEqual([
      { name: "Error", message: "text" },
    ]);
    expect(errorCauses(new Error("a"))).toEqual([]);
    expect(errorCauses("not an error")).toEqual([]);
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(errorCauses(a)).toEqual([{ name: "Error", message: "b" }]);
  });
});

describe("ToolError", () => {
  it("keeps details and cause; ToolRunError is a ToolError", () => {
    const cause = new Error("inner");
    const err = new ToolError("outer", { details: { a: 1 }, cause });
    expect(err.details).toEqual({ a: 1 });
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("ToolError");
    const run = new ToolRunError("stop");
    expect(run).toBeInstanceOf(ToolError);
    expect(run.details).toBeUndefined();
    expect(run.name).toBe("ToolRunError");
  });
});

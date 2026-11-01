import { describe, expect, it } from "vitest";
import { chunkText } from "./chunking.js";

describe("chunkText", () => {
  it("keeps short text as one chunk and drops blank text", () => {
    expect(chunkText("Hello there.")).toEqual(["Hello there."]);
    expect(chunkText("  \n ")).toEqual([]);
  });

  it("splits at Markdown headings first, packing small sections", () => {
    const a = "# A\n" + "a".repeat(30) + "\n";
    const b = "# B\n" + "b".repeat(30) + "\n";
    const c = "# C\n" + "c".repeat(30) + "\n";
    const chunks = chunkText(a + b + c, 80);
    expect(chunks).toEqual([(a + b).trim(), c.trim()]);
  });

  it("splits a long section at blank lines, then at sentences", () => {
    const para = (ch: string) => `${ch.repeat(20)}. ${ch.repeat(20)}.`;
    const text = `${para("x")}\n\n${para("y")}`;
    expect(chunkText(text, 50)).toEqual([para("x"), para("y")]);
    expect(chunkText(para("z"), 25)).toEqual([
      `${"z".repeat(20)}.`,
      `${"z".repeat(20)}.`,
    ]);
  });

  it("cuts inside a sentence only as a last resort", () => {
    const chunks = chunkText("q".repeat(250), 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it("never makes a chunk longer than the limit, and loses no text", () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `## Part ${i}\n\nSentence one of ${i}. Sentence two!\n`,
    ).join("\n");
    const chunks = chunkText(text, 300);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });
});

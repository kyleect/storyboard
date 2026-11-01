import { describe, expect, it } from "vitest";
import { cleanTitle, TITLE_MAX } from "./auto-title.js";

/* Title cleanup (auto-rename plan, step 4). */

describe("cleanTitle", () => {
  it("takes the first non-empty line, trimmed", () => {
    expect(cleanTitle("\n\n  The Keeper  \nmore")).toBe("The Keeper");
  });

  it("strips matching surrounding quotes", () => {
    expect(cleanTitle('"The Keeper"')).toBe("The Keeper");
    expect(cleanTitle("'The Keeper'")).toBe("The Keeper");
    expect(cleanTitle("“The Keeper”")).toBe("The Keeper");
    expect(cleanTitle("‘The Keeper’")).toBe("The Keeper");
    expect(cleanTitle('"The Keeper')).toBe('"The Keeper');
  });

  it("strips trailing . , ; : and keeps ? and !", () => {
    expect(cleanTitle('"The Keeper."')).toBe("The Keeper");
    expect(cleanTitle("The Keeper;:,.")).toBe("The Keeper");
    expect(cleanTitle("Who Keeps?")).toBe("Who Keeps?");
    expect(cleanTitle("Keep!")).toBe("Keep!");
  });

  it("collapses whitespace", () => {
    expect(cleanTitle("The   \t Keeper")).toBe("The Keeper");
  });

  it("is empty when nothing usable is left", () => {
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle(" \n \n")).toBe("");
    expect(cleanTitle('""')).toBe("");
    expect(cleanTitle("...")).toBe("");
  });

  it("keeps a title of exactly the limit", () => {
    const title = "a".repeat(TITLE_MAX);
    expect(cleanTitle(title)).toBe(title);
  });

  it("cuts a longer title at a word boundary, with the … inside the limit", () => {
    const words = "word ".repeat(30).trim();
    const title = cleanTitle(words);
    expect([...title].length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title.endsWith("word…")).toBe(true);
    expect(title).toBe(`${"word ".repeat(15).trim()}…`);
  });

  it("cuts hard when there is no space", () => {
    const title = cleanTitle("x".repeat(100));
    expect(title).toBe(`${"x".repeat(TITLE_MAX - 1)}…`);
  });
});

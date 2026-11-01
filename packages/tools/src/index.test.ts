import { describe, expect, it } from "vitest";
import { allTools } from "./index.js";

describe("allTools", () => {
  it("lists every tool once", () => {
    expect(allTools.map((t) => t.name)).toEqual([
      "current_date",
      "current_time",
      "web_search",
      "read_webpage",
    ]);
  });
});

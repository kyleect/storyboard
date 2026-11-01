import { describe, expect, it } from "vitest";
import { allTools } from "./index.js";

describe("allTools", () => {
  it("lists every tool once", () => {
    expect(allTools.map((t) => t.name)).toEqual([
      "current_date",
      "current_time",
      "web_search",
      "read_webpage",
      "ask_user",
      "files_list",
      "files_read",
      "files_write",
      "files_delete",
      "files_search",
      "memory_list",
      "memory_add",
      "memory_update",
      "memory_delete",
      "memory_search",
    ]);
  });
});

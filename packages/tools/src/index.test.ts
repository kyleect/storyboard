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
      "read_wiki",
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
      "files_copy",
      "memory_copy",
      "files_move",
      "memory_move",
      "projects_list",
      "project_view",
      "project_create",
      "agents_list",
      "agent_view",
      "agent_change",
      "skill_load",
    ]);
  });
});

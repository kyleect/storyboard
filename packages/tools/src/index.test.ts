import { describe, expect, it } from "vitest";
import { TOOL_GROUPS, type ToolGroup } from "@harness/core";
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
      "files_folder_create",
      "files_folder_rename",
      "files_folder_delete",
      "files_search",
      "files_copy",
      "files_move",
      "projects_list",
      "project_view",
      "project_create",
      "agents_list",
      "agent_view",
      "start_subagent",
      "subagent_handback",
      "skill_load",
      "schemas_list",
      "schema_view",
      "schema_create",
      "schema_update",
      "schema_copy",
      "schema_delete",
      "data_list",
      "data_view",
      "data_create",
      "data_update",
      "data_migrate",
      "data_migrate_many",
      "data_delete",
      "workspaces_list",
      "workspace_list",
      "workspace_read",
      "workspace_search",
      "workspace_write",
      "workspace_edit",
      "workspace_move",
      "workspace_delete",
      "workspace_folder_create",
      "workspace_folder_rename",
      "workspace_folder_delete",
    ]);
  });

  it("puts every tool in a known group", () => {
    const groups = new Set<string>(TOOL_GROUPS.map((g) => g.id));
    for (const t of allTools) expect(groups.has(t.group), t.name).toBe(true);
  });

  it("assigns the groups of tool management plan 1.9", () => {
    const byGroup: Partial<Record<ToolGroup, string[]>> = {};
    for (const t of allTools) (byGroup[t.group] ??= []).push(t.name);
    expect(byGroup).toEqual({
      files: [
        "files_list",
        "files_read",
        "files_write",
        "files_delete",
        "files_folder_create",
        "files_folder_rename",
        "files_folder_delete",
        "files_search",
        "files_copy",
        "files_move",
      ],
      "structured-data": [
        "schemas_list",
        "schema_view",
        "schema_create",
        "schema_update",
        "schema_copy",
        "schema_delete",
        "data_list",
        "data_view",
        "data_create",
        "data_update",
        "data_migrate",
        "data_migrate_many",
        "data_delete",
      ],
      workspaces: [
        "workspaces_list",
        "workspace_list",
        "workspace_read",
        "workspace_search",
        "workspace_write",
        "workspace_edit",
        "workspace_move",
        "workspace_delete",
        "workspace_folder_create",
        "workspace_folder_rename",
        "workspace_folder_delete",
      ],
      projects: ["projects_list", "project_view", "project_create"],
      agents: ["agents_list", "agent_view"],
      subagents: ["start_subagent", "subagent_handback"],
      skills: ["skill_load"],
      web: ["web_search", "read_webpage", "read_wiki"],
      utilities: ["current_date", "current_time", "ask_user"],
    });
  });

  it("is always on only for the two run-dependent tools (files unification design, D23, D49)", () => {
    // The files tools are no longer always on (files unification design,
    // D23 and D49).
    expect(allTools.filter((t) => t.alwaysOn).map((t) => t.name)).toEqual([
      "subagent_handback",
      "skill_load",
    ]);
  });

  it("marks the workspace tools that change something as needing review", () => {
    expect(allTools.filter((t) => t.needsReview).map((t) => t.name)).toEqual([
      "workspace_write",
      "workspace_edit",
      "workspace_move",
      "workspace_delete",
      "workspace_folder_create",
      "workspace_folder_rename",
      "workspace_folder_delete",
    ]);
    // Reading and listing never ask; changes always do, per workspace.
    for (const t of allTools.filter((t) => t.group === "workspaces")) {
      expect(t.approval, t.name).toBe(t.needsReview ? "ask" : "never");
      expect(t.approvalSubject !== undefined, t.name).toBe(t.needsReview);
    }
  });

  it("offers the workspace tools only to a run with a workspace", () => {
    for (const t of allTools.filter((t) => t.group === "workspaces")) {
      const run = {
        hasSkills: false,
        isChild: false,
        canStartSubagent: false,
      };
      expect(t.available?.(run), t.name).toBe(false);
      expect(t.available?.({ ...run, hasWorkspaces: true }), t.name).toBe(true);
    }
  });

  it("makes the three conditional tools depend on the run", () => {
    const find = (name: string) => {
      const tool = allTools.find((t) => t.name === name);
      if (!tool?.available) throw new Error(`${name} has no available()`);
      return tool.available;
    };
    const run = { hasSkills: false, isChild: false, canStartSubagent: false };
    expect(find("skill_load")(run)).toBe(false);
    expect(find("skill_load")({ ...run, hasSkills: true })).toBe(true);
    expect(find("subagent_handback")(run)).toBe(false);
    expect(find("subagent_handback")({ ...run, isChild: true })).toBe(true);
    expect(find("start_subagent")(run)).toBe(false);
    expect(find("start_subagent")({ ...run, canStartSubagent: true })).toBe(
      true,
    );
    const others = allTools.filter(
      (t) =>
        t.group !== "workspaces" &&
        !["skill_load", "subagent_handback", "start_subagent"].includes(t.name),
    );
    for (const t of others) expect(t.available, t.name).toBeUndefined();
  });
});

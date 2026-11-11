import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  agentKeys,
  dataKeys,
  entryKeys,
  errorKeys,
  mcpKeys,
  modelKeys,
  projectKeys,
  runKeys,
  schemaKeys,
  sessionKeys,
  skillKeys,
  toolKeys,
  trashKeys,
  workspaceKeys,
} from "./index";

type Keys = Record<string, readonly unknown[]>;

/** The names of the queries that invalidating `prefix` marks stale. */
async function reach(prefix: readonly unknown[], keys: Keys) {
  const client = new QueryClient();
  for (const key of Object.values(keys)) client.setQueryData(key, "cached");
  await client.invalidateQueries({ queryKey: prefix, refetchType: "none" });
  return Object.entries(keys)
    .filter(([, key]) => client.getQueryState(key)?.isInvalidated)
    .map(([name]) => name)
    .sort();
}

describe("session and project keys", () => {
  const keys: Keys = {
    listOfProject: sessionKeys.list("p1"),
    listWithoutProject: sessionKeys.list(null),
    page: sessionKeys.page({
      projectId: "p1",
      direction: "desc",
      page: 1,
      pageSize: 10,
    }),
    otherPage: sessionKeys.page({
      projectId: null,
      direction: "asc",
      page: 2,
      pageSize: 25,
    }),
    detail: sessionKeys.detail("s1"),
    otherDetail: sessionKeys.detail("s2"),
    debug: sessionKeys.debug("s1"),
    pickable: sessionKeys.pickableAgentsFor("s1"),
    trash: trashKeys.all,
    projects: projectKeys.list(),
    project: projectKeys.detail("p1"),
  };

  it("lists() reaches every session list, the Sessions page's too, and nothing else", async () => {
    expect(await reach(sessionKeys.lists(), keys)).toEqual([
      "listOfProject",
      "listWithoutProject",
      "otherPage",
      "page",
    ]);
  });

  it("list(projectId) reaches only that project's list", async () => {
    expect(await reach(sessionKeys.list("p1"), keys)).toEqual([
      "listOfProject",
    ]);
  });

  it("pages() reaches every page of the Sessions page, page(...) one", async () => {
    expect(await reach(sessionKeys.pages(), keys)).toEqual([
      "otherPage",
      "page",
    ]);
    expect(
      await reach(
        sessionKeys.page({
          projectId: "p1",
          direction: "desc",
          page: 1,
          pageSize: 10,
        }),
        keys,
      ),
    ).toEqual(["page"]);
  });

  it("details() reaches every open session, detail(id) one", async () => {
    expect(await reach(sessionKeys.details(), keys)).toEqual([
      "detail",
      "otherDetail",
    ]);
    expect(await reach(sessionKeys.detail("s1"), keys)).toEqual(["detail"]);
  });

  it("pickableAgents() reaches each session's agent choices", async () => {
    expect(await reach(sessionKeys.pickableAgents(), keys)).toEqual([
      "pickable",
    ]);
  });

  it("projects list and detail are refreshed separately", async () => {
    expect(await reach(projectKeys.list(), keys)).toEqual(["projects"]);
    expect(await reach(projectKeys.details(), keys)).toEqual(["project"]);
    expect(await reach(projectKeys.all, keys)).toEqual(["project", "projects"]);
  });
});

describe("agent keys", () => {
  const global = { scope: "global" } as const;
  const project = { scope: "project", id: "p1" } as const;
  const keys: Keys = {
    globalList: agentKeys.list(global, false),
    globalListDeleted: agentKeys.list(global, true),
    projectList: agentKeys.list(project, false),
    globalTargets: agentKeys.copyTargets(global),
    projectTargets: agentKeys.copyTargets(project),
    detail: agentKeys.detail("a1"),
    version: agentKeys.version("a1", 2),
  };

  it("scopeLists(scope) reaches that scope's lists only", async () => {
    expect(await reach(agentKeys.scopeLists(global), keys)).toEqual([
      "globalList",
      "globalListDeleted",
    ]);
    expect(await reach(agentKeys.scopeLists(project), keys)).toEqual([
      "projectList",
    ]);
  });

  it("copyTargets(scope) reaches that scope's targets only", async () => {
    expect(await reach(agentKeys.copyTargets(global), keys)).toEqual([
      "globalTargets",
    ]);
  });

  it("details() reaches agents, not lists", async () => {
    expect(await reach(agentKeys.details(), keys)).toEqual(["detail"]);
  });

  it("all reaches everything about agents", async () => {
    expect(await reach(agentKeys.all, keys)).toEqual(Object.keys(keys).sort());
  });
});

describe("skill keys", () => {
  const keys: Keys = {
    globalList: skillKeys.list({ scope: "global" }, false),
    agentList: skillKeys.list({ scope: "agent", id: "a1" }, false),
    detail: skillKeys.detail("k1"),
  };

  it("lists() and details() are separate", async () => {
    expect(await reach(skillKeys.lists(), keys)).toEqual([
      "agentList",
      "globalList",
    ]);
    expect(await reach(skillKeys.details(), keys)).toEqual(["detail"]);
  });
});

describe("entry keys", () => {
  const session = { scope: "session", id: "s1" } as const;
  const other = { scope: "session", id: "s2" } as const;
  const keys: Keys = {
    fileList: entryKeys.list(session, "file", false),
    fileDetail: entryKeys.detail(session, "file", "a.md"),
    noteList: entryKeys.list(session, "note", false),
    noteDetail: entryKeys.detail(session, "note", "n1"),
    otherFileList: entryKeys.list(other, "file", false),
    globalFileList: entryKeys.list({ scope: "global" }, "file", false),
  };

  it("inScope(scope) reaches that scope's files and notes only", async () => {
    expect(await reach(entryKeys.inScope(session), keys)).toEqual([
      "fileDetail",
      "fileList",
      "noteDetail",
      "noteList",
    ]);
  });

  it("ofKind, lists and details narrow it down", async () => {
    expect(await reach(entryKeys.ofKind(session, "file"), keys)).toEqual([
      "fileDetail",
      "fileList",
    ]);
    expect(await reach(entryKeys.lists(session, "file"), keys)).toEqual([
      "fileList",
    ]);
    expect(await reach(entryKeys.details(session, "note"), keys)).toEqual([
      "noteDetail",
    ]);
  });
});

describe("data and schema keys", () => {
  const owner = { scope: "project", id: "p1" } as const;
  const keys: Keys = {
    dataList: dataKeys.list(owner, false),
    dataDetail: dataKeys.detail(owner, "d1"),
    schemaInfos: dataKeys.schemaInfos(owner),
    schemaList: schemaKeys.list(owner, false),
    schemaDetail: schemaKeys.detail(owner, "x1"),
    schemaLatest: schemaKeys.latest("x1"),
  };

  it("dataKeys.all refreshes data and schemas", async () => {
    expect(await reach(dataKeys.all, keys)).toEqual(Object.keys(keys).sort());
  });

  it("schemaKeys.all leaves the data alone", async () => {
    expect(await reach(schemaKeys.all, keys)).toEqual([
      "schemaDetail",
      "schemaLatest",
      "schemaList",
    ]);
  });
});

describe("tool, model and error keys", () => {
  it("the tool queries are refreshed separately", async () => {
    const keys: Keys = {
      list: toolKeys.list(),
      selectable: toolKeys.selectable(),
      approvals: toolKeys.approvals(),
      mcp: mcpKeys.list(),
    };
    expect(await reach(toolKeys.list(), keys)).toEqual(["list"]);
    expect(await reach(toolKeys.selectable(), keys)).toEqual(["selectable"]);
    expect(await reach(toolKeys.approvals(), keys)).toEqual(["approvals"]);
    expect(await reach(mcpKeys.all, keys)).toEqual(["mcp"]);
  });

  it("refreshing models does not refetch the context size", async () => {
    const keys: Keys = {
      list: modelKeys.list(),
      levels: modelKeys.reasoningLevel("m1"),
      defaultLevels: modelKeys.reasoningLevel(undefined),
      size: modelKeys.contextSize("m1"),
    };
    expect(await reach(modelKeys.list(), keys)).toEqual(["list"]);
    expect(await reach(modelKeys.reasoningLevels(), keys)).toEqual([
      "defaultLevels",
      "levels",
    ]);
  });

  it("errors: one session's list, or every console", async () => {
    const keys: Keys = {
      global: errorKeys.list(),
      session: errorKeys.list({ sessionId: "s1" }),
      otherSession: errorKeys.list({ sessionId: "s2" }),
      filters: errorKeys.filters(),
    };
    expect(await reach(errorKeys.list({ sessionId: "s1" }), keys)).toEqual([
      "session",
    ]);
    expect(await reach(errorKeys.all, keys)).toEqual(Object.keys(keys).sort());
  });

  it("a model without a name and the default model share a key", () => {
    expect(modelKeys.reasoningLevel(null)).toEqual(
      modelKeys.reasoningLevel(undefined),
    );
  });

  it("workspaces: one prefix reaches lists, attachments, grants and files", async () => {
    const keys: Keys = {
      list: workspaceKeys.list(false),
      trash: workspaceKeys.list(true),
      projectAttached: workspaceKeys.attached("projects", "p1"),
      sessionAttached: workspaceKeys.attached("sessions", "s1"),
      grants: workspaceKeys.grants(),
      dirs: workspaceKeys.dirs("/a"),
      tree: workspaceKeys.tree("w1", "notes"),
      otherTree: workspaceKeys.tree("w2", ""),
      index: workspaceKeys.index("w1"),
      file: workspaceKeys.file("s1", "workspace://w1/a.png"),
      agents: agentKeys.all,
    };
    expect(await reach(workspaceKeys.lists(), keys)).toEqual(["list", "trash"]);
    expect(await reach(workspaceKeys.attached("sessions", "s1"), keys)).toEqual(
      ["sessionAttached"],
    );
    expect(await reach(workspaceKeys.attachedAll(), keys)).toEqual([
      "projectAttached",
      "sessionAttached",
    ]);
    expect(await reach(workspaceKeys.trees("w1"), keys)).toEqual(["tree"]);
    expect(await reach(workspaceKeys.index("w1"), keys)).toEqual(["index"]);
    expect(await reach(workspaceKeys.all, keys)).toEqual(
      Object.keys(keys)
        .filter((k) => k !== "agents")
        .sort(),
    );
  });
});

describe("run keys", () => {
  it("one prefix reaches the active runs and nothing else", async () => {
    const keys: Keys = {
      active: runKeys.active(),
      sessions: sessionKeys.list(null),
      detail: sessionKeys.detail("s1"),
    };
    expect(await reach(runKeys.all, keys)).toEqual(["active"]);
    expect(await reach(runKeys.active(), keys)).toEqual(["active"]);
  });
});

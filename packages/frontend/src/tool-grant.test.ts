import { describe, expect, it } from "vitest";
import {
  emptyGrant,
  forget,
  groupApproval,
  groupCount,
  groupTools,
  hasTool,
  mcpServerOf,
  sectionTools,
  setGroup,
  setGroupApproval,
  setTool,
  setTools,
  switchMode,
  toggleState,
  type GrantTool,
  type ToolGrant,
} from "./tool-grant";

const t = (
  name: string,
  group: GrantTool["group"],
  over: Partial<GrantTool> = {},
): GrantTool => ({ name, group, needsReview: false, alwaysOn: false, ...over });

const files = [
  t("files_read", "files", { alwaysOn: true }),
  t("files_edit", "files"),
  t("files_kill", "files", { needsReview: true }),
];
const web = [t("web_search", "web"), t("read_webpage", "web")];
const ALL = [...files, ...web];

const grant = (over: Partial<ToolGrant> = {}): ToolGrant => ({
  ...emptyGrant(),
  ...over,
});
const has = (g: ToolGrant) =>
  ALL.filter((x) => hasTool(g, x)).map((x) => x.name);

describe("groupTools", () => {
  it("orders groups as the app shows them and leaves out empty ones", () => {
    const groups = groupTools([...web, ...files]);
    expect(groups.map((g) => [g.id, g.label])).toEqual([
      ["files", "Files"],
      ["web", "Web"],
    ]);
    expect(groups[0]?.tools).toEqual(files);
  });
});

const mcp = [
  t("mcp_notes_search", "mcp"),
  t("mcp_notes_write", "mcp", { needsReview: true }),
  t("mcp_calendar-app_list", "mcp"),
];
const calendarTool = t("mcp_calendar-app_list", "mcp");

describe("mcpServerOf", () => {
  it("takes the server from mcp_<server>_<tool>", () => {
    expect(mcpServerOf("mcp_notes_search")).toBe("notes");
    expect(mcpServerOf("mcp_calendar-app_list_events")).toBe("calendar-app");
    expect(mcpServerOf("files_read")).toBeUndefined();
  });
});

describe("sectionTools", () => {
  it("nests a section per server in the MCP group, in order of server name", () => {
    const sections = sectionTools([...mcp, ...web]);
    expect(sections.map((x) => [x.id, x.label])).toEqual([
      ["web", "Web"],
      ["mcp", "MCP"],
    ]);
    expect(sections[0]?.children).toBeUndefined();
    // The MCP group still holds every MCP tool.
    expect(sections[1]?.tools).toEqual(mcp);
    const servers = sections[1]?.children ?? [];
    expect(servers.map((x) => [x.id, x.label, x.group])).toEqual([
      ["mcp:calendar-app", "calendar-app", "mcp"],
      ["mcp:notes", "notes", "mcp"],
    ]);
    expect(servers[1]?.tools.map((x) => x.name)).toEqual([
      "mcp_notes_search",
      "mcp_notes_write",
    ]);
  });

  it("puts an MCP tool with no server in a section named Other, last", () => {
    const sections = sectionTools([t("mcp", "mcp"), ...mcp]);
    expect(sections[0]?.children?.map((x) => x.label)).toEqual([
      "calendar-app",
      "notes",
      "Other",
    ]);
  });
});

describe("setTools", () => {
  const server = mcp.slice(0, 2);

  it("switches one server on without granting the whole MCP group", () => {
    const g = setTools(grant(), server, true);
    expect(g.groups).toEqual([]);
    // The tool that needs review is left as it was.
    expect(g.extras).toEqual(["mcp_notes_search"]);
    expect(hasTool(g, calendarTool)).toBe(false);
  });

  it("switches one server off, review tools included", () => {
    const g = setTools(
      grant({ extras: ["mcp_notes_search", "mcp_notes_write"] }),
      server,
      false,
    );
    expect(g.extras).toEqual([]);
  });

  it("leaves the other servers alone when the MCP group is granted", () => {
    const g = setTools(grant({ groups: ["mcp"] }), server, false);
    expect(g.except).toEqual(["mcp_notes_search"]);
    expect(hasTool(g, calendarTool)).toBe(true);
  });
});

describe("hasTool", () => {
  it("always has an always-on tool", () => {
    expect(has(grant())).toEqual(["files_read"]);
  });

  it("follows the groups, exceptions and extras of an allow grant", () => {
    const g = grant({
      groups: ["web"],
      except: ["read_webpage"],
      extras: ["files_edit"],
    });
    expect(has(g)).toEqual(["files_read", "files_edit", "web_search"]);
  });

  it("does not let a group cover a tool that needs review", () => {
    expect(has(grant({ groups: ["files"] }))).toEqual([
      "files_read",
      "files_edit",
    ]);
    expect(has(grant({ groups: ["files"], extras: ["files_kill"] }))).toEqual([
      "files_read",
      "files_edit",
      "files_kill",
    ]);
  });

  it("has everything but what a deny grant denies", () => {
    const g = grant({ mode: "deny", groups: ["web"], except: ["web_search"] });
    // files_kill needs review, so a deny grant does not give it.
    expect(has(g)).toEqual(["files_read", "files_edit", "web_search"]);
  });

  it("gives a tool that needs review in deny mode only when it is in except", () => {
    const g = grant({ mode: "deny", except: ["files_kill"] });
    expect(has(g)).toContain("files_kill");
    // Whether or not its group is denied.
    expect(
      has(grant({ mode: "deny", groups: ["files"], except: ["files_kill"] })),
    ).toEqual(["files_read", "files_kill", ...web.map((x) => x.name)]);
  });
});

describe("setTool", () => {
  it("adds a single tool as an extra when its group is not granted", () => {
    const g = setTool(grant(), web[0] as GrantTool, true);
    expect(g.extras).toEqual(["web_search"]);
    expect(setTool(g, web[0] as GrantTool, false)).toEqual(grant());
  });

  it("makes an exception when a tool of a granted group is switched off", () => {
    const g = setTool(grant({ groups: ["web"] }), web[0] as GrantTool, false);
    expect(g).toEqual(grant({ groups: ["web"], except: ["web_search"] }));
    expect(setTool(g, web[0] as GrantTool, true)).toEqual(
      grant({ groups: ["web"] }),
    );
  });

  it("accepts a tool that needs review by listing it on its own", () => {
    const review = files[2] as GrantTool;
    const g = setTool(grant({ groups: ["files"] }), review, true);
    expect(g.extras).toEqual(["files_kill"]);
    expect(g.except).toEqual([]);
    expect(setTool(g, review, false).extras).toEqual([]);
  });

  it("denies and allows in deny mode", () => {
    const g = grant({ mode: "deny" });
    // Denying a tool outside a denied group lists it.
    const denied = setTool(g, web[0] as GrantTool, false);
    expect(denied.extras).toEqual(["web_search"]);
    expect(setTool(denied, web[0] as GrantTool, true)).toEqual(g);
    // Allowing a tool inside a denied group makes an exception.
    const inGroup = setTool(
      grant({ mode: "deny", groups: ["web"] }),
      web[0] as GrantTool,
      true,
    );
    expect(inGroup.except).toEqual(["web_search"]);
    expect(has(inGroup)).toContain("web_search");
  });
});

describe("tools that need review in deny mode", () => {
  const kill = files[2] as GrantTool;

  it("gives and takes back a tool by listing it in except", () => {
    const on = setTool(grant({ mode: "deny" }), kill, true);
    expect(on.except).toEqual(["files_kill"]);
    expect(hasTool(on, kill)).toBe(true);
    const off = setTool(on, kill, false);
    expect(off.except).toEqual([]);
    expect(hasTool(off, kill)).toBe(false);
  });

  it("leaves it as it was when its group is switched on", () => {
    const given = grant({
      mode: "deny",
      groups: ["files"],
      except: ["files_kill"],
    });
    const on = setGroup(given, "files", files, true);
    expect(on.groups).toEqual([]);
    expect(on.except).toEqual(["files_kill"]);
    const notGiven = setGroup(
      grant({ mode: "deny", groups: ["files"] }),
      "files",
      files,
      true,
    );
    expect(hasTool(notGiven, kill)).toBe(false);
  });

  it("takes it away when its group is switched off", () => {
    const off = setGroup(
      grant({ mode: "deny", except: ["files_kill"] }),
      "files",
      files,
      false,
    );
    expect(off.groups).toEqual(["files"]);
    expect(hasTool(off, kill)).toBe(false);
  });
});

describe("setGroup", () => {
  it("grants a group and clears its exceptions and extras", () => {
    const start = grant({
      except: ["x"],
      extras: ["web_search", "files_edit"],
    });
    const g = setGroup(start, "web", web, true);
    expect(g.groups).toEqual(["web"]);
    expect(g.extras).toEqual(["files_edit"]);
  });

  it("keeps an accepted tool that needs review when the group is switched on", () => {
    const g = setGroup(grant({ extras: ["files_kill"] }), "files", files, true);
    expect(g.extras).toEqual(["files_kill"]);
    expect(has(g)).toEqual(["files_read", "files_edit", "files_kill"]);
  });

  it("switches a group off, including a tool that needs review", () => {
    const g = setGroup(
      grant({
        groups: ["files"],
        extras: ["files_kill"],
        except: ["files_edit"],
      }),
      "files",
      files,
      false,
    );
    expect(g).toEqual(grant());
  });

  it("denies a group in deny mode when it is switched off, and allows it when on", () => {
    const denied = setGroup(grant({ mode: "deny" }), "web", web, false);
    expect(denied.groups).toEqual(["web"]);
    const allowed = setGroup(denied, "web", web, true);
    expect(allowed.groups).toEqual([]);
  });
});

describe("counts and state", () => {
  it("counts the always-on tool as on", () => {
    expect(groupCount(grant(), files)).toEqual({ on: 1, total: 3 });
    expect(toggleState(grant(), files)).toBe("mixed");
    expect(toggleState(grant(), web)).toBe("none");
    expect(toggleState(grant({ groups: ["web"] }), web)).toBe("all");
  });
});

describe("forget", () => {
  it("removes a name from the exceptions and extras", () => {
    expect(forget(grant({ except: ["a"], extras: ["a", "b"] }), "a")).toEqual(
      grant({ extras: ["b"] }),
    );
  });
});

describe("group approval", () => {
  const tools = [
    { name: "a", fixed: false },
    { name: "b", fixed: false },
    { name: "locked", fixed: true },
  ];

  it("reads own, ask, skip and mixed across the tools that can have a choice", () => {
    expect(groupApproval({}, tools)).toBe("own");
    expect(groupApproval({ a: true, b: true }, tools)).toBe("ask");
    expect(groupApproval({ a: false, b: false }, tools)).toBe("skip");
    expect(groupApproval({ a: true }, tools)).toBe("mixed");
    expect(groupApproval({ a: true, b: false }, tools)).toBe("mixed");
    // A group of only fixed tools has nothing to set.
    expect(groupApproval({}, [{ name: "locked", fixed: true }])).toBe("own");
  });

  it("sets every tool but a fixed one, and leaves other groups alone", () => {
    expect(setGroupApproval({ other: true }, tools, "ask")).toEqual({
      other: true,
      a: true,
      b: true,
    });
    expect(
      setGroupApproval({ a: true, b: false, other: true }, tools, "own"),
    ).toEqual({
      other: true,
    });
    expect(setGroupApproval({}, tools, "skip")).toEqual({ a: false, b: false });
  });
});

describe("switchMode", () => {
  const same = (a: ToolGrant, b: ToolGrant) =>
    ALL.map((x) => hasTool(a, x)) &&
    expect(ALL.map((x) => hasTool(a, x))).toEqual(
      ALL.map((x) => hasTool(b, x)),
    );

  it("does nothing when the mode is already that", () => {
    const g = grant({ groups: ["web"] });
    expect(switchMode(g, "allow", ALL)).toBe(g);
  });

  it("writes an allow list as a deny list with the same tools", () => {
    const g = grant({ groups: ["web"], extras: ["files_edit"] });
    const d = switchMode(g, "deny", ALL);
    expect(d.mode).toBe("deny");
    same(g, d);
    // Nothing is denied that is not off by default: no groups, no extras.
    expect(d.groups).toEqual([]);
    expect(d.extras).toEqual([]);
    expect(d.except).toEqual([]);
  });

  it("keeps a tool that needs review that is given when going to deny", () => {
    const g = grant({ extras: ["files_kill"], groups: ["files"] });
    const d = switchMode(g, "deny", ALL);
    same(g, d);
    expect(d.except).toEqual(["files_kill"]);
    expect(d.groups).toEqual(["web"]);
    // And back again.
    const back = switchMode(d, "allow", ALL);
    same(g, back);
    expect(back.groups).toEqual(["files"]);
    expect(back.extras).toEqual(["files_kill"]);
  });

  it("writes a deny list as an allow list with the same tools", () => {
    const g = grant({ mode: "deny", groups: ["web"] });
    const a = switchMode(g, "allow", ALL);
    expect(a.mode).toBe("allow");
    same(g, a);
    // Everything but web is kept, so Files becomes a group.
    expect(a.groups).toEqual(["files"]);
  });

  it("uses a whole group where every tool is covered", () => {
    const g = grant({ mode: "deny", groups: ["files"] });
    const a = switchMode(g, "allow", ALL);
    // Denied: all of files. Allowed: web.
    expect(a.groups).toEqual(["web"]);
    expect(a.extras).toEqual([]);
    const back = switchMode(a, "deny", ALL);
    expect(back.groups).toEqual(["files"]);
  });
});

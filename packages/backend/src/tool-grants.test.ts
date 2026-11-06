import { describe, expect, it } from "vitest";
import {
  allowedNames,
  emptyGrant,
  grantFromNames,
  listedTools,
  newToolNames,
  normalizeGrant,
  type GrantTool,
} from "./tool-grants.js";

const t = (
  name: string,
  group: GrantTool["group"],
  needsReview = false,
): GrantTool => ({ name, group, needsReview });

const TOOLS = [
  t("files_edit", "files"),
  t("files_kill", "files", true),
  t("memory_add", "memory"),
  t("web_search", "web"),
  t("read_webpage", "web"),
  t("read_wiki", "web"),
];

const grant = (over: Partial<ReturnType<typeof emptyGrant>> = {}) => ({
  ...emptyGrant(),
  ...over,
});

describe("allowedNames", () => {
  it("allows nothing for an empty allow grant", () => {
    expect(allowedNames(grant(), TOOLS)).toEqual([]);
  });

  it("allows a granted group, less its exceptions, plus extras", () => {
    const g = grant({
      groups: ["web"],
      except: ["read_wiki"],
      extras: ["memory_add"],
    });
    expect(allowedNames(g, TOOLS)).toEqual([
      "memory_add",
      "web_search",
      "read_webpage",
    ]);
  });

  it("does not let a group grant cover a tool that needs review", () => {
    expect(allowedNames(grant({ groups: ["files"] }), TOOLS)).toEqual([
      "files_edit",
    ]);
    // Listed on its own, it is accepted (plan P5).
    expect(
      allowedNames(grant({ groups: ["files"], extras: ["files_kill"] }), TOOLS),
    ).toEqual(["files_edit", "files_kill"]);
  });

  it("allows everything but tools that need review for an empty deny grant", () => {
    const names = allowedNames(grant({ mode: "deny" }), TOOLS);
    expect(names).toHaveLength(TOOLS.length - 1);
    expect(names).not.toContain("files_kill");
  });

  it("gives a tool that needs review to a deny agent when it is listed in except", () => {
    expect(
      allowedNames(grant({ mode: "deny", except: ["files_kill"] }), TOOLS),
    ).toContain("files_kill");
    // Even inside a denied group, except means it is still allowed.
    expect(
      allowedNames(
        grant({ mode: "deny", groups: ["files"], except: ["files_kill"] }),
        TOOLS,
      ),
    ).toEqual([
      "files_kill",
      "memory_add",
      "web_search",
      "read_webpage",
      "read_wiki",
    ]);
  });

  it("denies a tool that needs review that is also in extras", () => {
    expect(
      allowedNames(
        grant({ mode: "deny", except: ["files_kill"], extras: ["files_kill"] }),
        TOOLS,
      ),
    ).not.toContain("files_kill");
  });

  it("denies a denied group less its exceptions, and the extras", () => {
    const g = grant({
      mode: "deny",
      groups: ["web"],
      except: ["web_search"],
      extras: ["memory_add"],
    });
    expect(allowedNames(g, TOOLS)).toEqual(["files_edit", "web_search"]);
  });

  it("ignores names of tools that do not exist", () => {
    expect(
      allowedNames(grant({ extras: ["gone"], except: ["gone"] }), TOOLS),
    ).toEqual([]);
  });
});

describe("listedTools", () => {
  it("lists the allowed tools for an allow agent", () => {
    expect(listedTools(grant({ groups: ["memory"] }), TOOLS)).toEqual({
      toolMode: "allow",
      tools: ["memory_add"],
    });
  });

  it("lists the denied tools for a deny agent", () => {
    expect(
      listedTools(grant({ mode: "deny", groups: ["web"] }), TOOLS),
    ).toEqual({
      toolMode: "deny",
      // A tool that needs review is denied until it is given.
      tools: ["files_kill", "web_search", "read_webpage", "read_wiki"],
    });
  });
});

describe("newToolNames", () => {
  it("names the tools that are not in the known set", () => {
    const g = grant({ known: ["files_edit", "memory_add"] });
    expect(newToolNames(g, TOOLS)).toEqual([
      "files_kill",
      "web_search",
      "read_webpage",
      "read_wiki",
    ]);
  });

  it("names only new tools that need review for a deny agent, which has the others on already", () => {
    expect(newToolNames(grant({ mode: "deny" }), TOOLS)).toEqual([
      "files_kill",
    ]);
    expect(
      newToolNames(
        grant({ mode: "deny", known: TOOLS.map((x) => x.name) }),
        TOOLS,
      ),
    ).toEqual([]);
  });
});

describe("grantFromNames", () => {
  it("makes single tools only, never a group", () => {
    // Even every tool of a group: an import cannot grant the group.
    const g = grantFromNames(
      "allow",
      ["web_search", "read_webpage", "read_wiki", "web_search"],
      TOOLS,
    );
    expect(g.groups).toEqual([]);
    expect(g.extras).toEqual(["web_search", "read_webpage", "read_wiki"]);
    expect(g.known).toEqual(TOOLS.map((x) => x.name));
  });
});

describe("grantFromNames, deny", () => {
  it("keeps a tool that needs review off only when the file names it", () => {
    const left = grantFromNames("deny", ["web_search"], TOOLS);
    expect(left.except).toEqual(["files_kill"]);
    expect(allowedNames(left, TOOLS)).toContain("files_kill");
    const named = grantFromNames("deny", ["files_kill"], TOOLS);
    expect(named.except).toEqual([]);
    expect(allowedNames(named, TOOLS)).not.toContain("files_kill");
  });
});

describe("normalizeGrant", () => {
  it("removes repeated entries", () => {
    expect(
      normalizeGrant(grant({ extras: ["a", "a"], groups: ["web", "web"] })),
    ).toEqual(grant({ extras: ["a"], groups: ["web"] }));
  });
});

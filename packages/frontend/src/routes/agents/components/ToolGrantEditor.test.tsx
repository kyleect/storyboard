import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { AgentToolInfo, ToolApprovalInfo } from "../../../api";
import { emptyGrant, type ToolGrant } from "../../../lib/tool-grant";
import { ToolGrantEditor } from "./ToolGrantEditor";

const tool = (
  name: string,
  group: AgentToolInfo["group"],
  over: Partial<AgentToolInfo> = {},
): AgentToolInfo => ({
  name,
  description: `${name} does a thing.`,
  group,
  alwaysOn: false,
  off: false,
  needsReview: false,
  ...over,
});

const TOOLS = [
  tool("files_read", "files", { alwaysOn: true }),
  tool("files_edit", "files"),
  tool("files_kill", "files", { needsReview: true }),
  tool("web_search", "web"),
  tool("read_webpage", "web", { off: true }),
];

const MCP_TOOLS = [
  tool("mcp_notes_search", "mcp"),
  tool("mcp_notes_write", "mcp", { needsReview: true }),
  tool("mcp_calendar_list", "mcp"),
];

const approvalsOf = (
  list: AgentToolInfo[],
  fixed: string[] = [],
): ToolApprovalInfo[] =>
  list.map((t) => ({
    name: t.name,
    description: t.description,
    group: t.group,
    alwaysOn: t.alwaysOn,
    ask: false,
    fixed: fixed.includes(t.name),
  }));

function setup(
  start: ToolGrant = emptyGrant(),
  newTools: string[] = [],
  startApproval: Record<string, boolean> = {},
  list: AgentToolInfo[] = TOOLS,
  fixed: string[] = [],
) {
  const seen = { grant: start, approval: startApproval };

  function Host() {
    const [grant, setGrant] = useState(start);
    const [approval, setApproval] = useState(startApproval);

    seen.grant = grant;
    seen.approval = approval;

    return (
      <ToolGrantEditor
        grant={grant}
        onGrant={setGrant}
        approval={approval}
        onApproval={setApproval}
        tools={list}
        approvals={approvalsOf(list, fixed)}
        newTools={new Set(newTools)}
      />
    );
  }

  render(
    <MantineProvider>
      <Host />
    </MantineProvider>,
  );

  return seen;
}

const boxOf = (name: string) =>
  screen
    .getByText(name)
    .closest(".mantine-Checkbox-root")
    ?.querySelector("input") as HTMLInputElement;

const choices = (label: string) =>
  within(screen.getByRole("radiogroup", { name: label }));

const picked = (label: string) =>
  choices(label)
    .queryAllByRole("radio")
    .filter((r) => (r as HTMLInputElement).checked);

const open = (label: string) =>
  fireEvent.click(screen.getByLabelText(`Show ${label} tools`));

describe("ToolGrantEditor", () => {
  it("shows groups collapsed, with how many tools each has on", () => {
    setup();
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByText("Web")).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByText("0 of 2")).toBeTruthy();
    expect(screen.queryByText("web_search")).toBeNull();
  });

  it("grants a whole group from its header", () => {
    const seen = setup();

    fireEvent.click(screen.getByLabelText("Web tools"));
    expect(seen.grant.groups).toEqual(["web"]);
    expect(screen.getByText("2 of 2")).toBeTruthy();
  });

  it("does not grant a tool that needs review with its group", () => {
    const seen = setup();

    fireEvent.click(screen.getByLabelText("Files tools"));
    expect(seen.grant.groups).toEqual(["files"]);
    expect(screen.getByText("2 of 3")).toBeTruthy();
    open("Files");
    expect(screen.getByText("needs review")).toBeTruthy();
    const kill = boxOf("files_kill");

    expect(kill.checked).toBe(false);
    fireEvent.click(kill);
    expect(seen.grant.extras).toEqual(["files_kill"]);
    expect(screen.getByText("3 of 3")).toBeTruthy();
  });

  it("shows an always-on tool locked and ticked", () => {
    setup();
    open("Files");
    expect(screen.getByText("always on")).toBeTruthy();
    const boxes = document.querySelectorAll("input[type=checkbox]");
    const locked = [...boxes].filter(
      (b) => (b as HTMLInputElement).disabled,
    ) as HTMLInputElement[];

    expect(locked).toHaveLength(1);
    expect(locked[0]?.checked).toBe(true);
  });

  it("leaves one tool out of a granted group", () => {
    const seen = setup({ ...emptyGrant(), groups: ["web"] });

    open("Web");
    fireEvent.click(boxOf("web_search"));
    expect(seen.grant.except).toEqual(["web_search"]);
    expect(screen.getByText("1 of 2")).toBeTruthy();
  });

  it("marks tools that are new, and opens their group", () => {
    setup(emptyGrant(), ["web_search"]);
    expect(screen.getByText("1 new")).toBeTruthy();
    // Opened because it has something new.
    expect(screen.getByText("web_search")).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy();
  });

  it("marks a tool that is off in Settings", () => {
    setup();
    open("Web");
    expect(screen.getByText("off in Settings")).toBeTruthy();
  });

  it("sets approval for a whole group", () => {
    const seen = setup({ ...emptyGrant(), groups: ["web"] });

    fireEvent.click(choices("Approval for Web tools").getByLabelText("Ask"));
    expect(seen.approval).toEqual({ web_search: true, read_webpage: true });
  });

  it("shows approval only for a group with something allowed", () => {
    setup();
    expect(
      screen.queryByRole("radiogroup", { name: "Approval for Web tools" }),
    ).toBeNull();
    fireEvent.click(screen.getByLabelText("Web tools"));
    expect(
      screen.getByRole("radiogroup", { name: "Approval for Web tools" }),
    ).toBeTruthy();
  });

  it("shows mixed approval when tools differ", () => {
    setup({ ...emptyGrant(), groups: ["web"] }, [], { web_search: true });
    expect(picked("Approval for Web tools")).toHaveLength(0);
    expect(screen.getByText("Mixed: its tools differ.")).toBeTruthy();
  });

  it("changes one tool's approval from its menu", async () => {
    const seen = setup({ ...emptyGrant(), groups: ["web"] });

    open("Web");
    fireEvent.click(screen.getByLabelText("Approval for web_search"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ask" }));
    expect(seen.approval).toEqual({ web_search: true });
  });

  it("does not offer a menu for a tool that always asks", () => {
    setup({ ...emptyGrant(), groups: ["web"] }, [], {}, TOOLS, ["web_search"]);
    open("Web");
    expect(screen.getByText("Always asks. The tool fixes this.")).toBeTruthy();
    expect(screen.queryByLabelText("Approval for web_search")).toBeNull();
  });

  it("groups MCP tools by server inside the MCP group, collapsed", () => {
    setup(emptyGrant(), [], {}, MCP_TOOLS);
    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.getByText("0 of 3")).toBeTruthy();
    expect(screen.queryByText("notes")).toBeNull();
    open("MCP");
    expect(screen.getByText("notes")).toBeTruthy();
    expect(screen.getByText("calendar")).toBeTruthy();
    expect(screen.getByText("0 of 1")).toBeTruthy();
    expect(screen.queryByText("mcp_notes_search")).toBeNull();
    open("notes");
    expect(screen.getByText("mcp_notes_search")).toBeTruthy();
    expect(screen.queryByText("mcp_calendar_list")).toBeNull();
  });

  it("grants the whole MCP group from its header", () => {
    const seen = setup(emptyGrant(), [], {}, MCP_TOOLS);

    fireEvent.click(screen.getByLabelText("MCP tools"));
    expect(seen.grant.groups).toEqual(["mcp"]);
    expect(screen.getByText("2 of 3")).toBeTruthy();
  });

  it("grants one server from its header, not the others", () => {
    const seen = setup(emptyGrant(), [], {}, MCP_TOOLS);

    open("MCP");
    fireEvent.click(screen.getByLabelText("calendar tools"));
    expect(seen.grant.groups).toEqual([]);
    expect(seen.grant.extras).toEqual(["mcp_calendar_list"]);
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
  });

  it("opens the group and server that have something new", () => {
    setup(emptyGrant(), ["mcp_calendar_list"], {}, MCP_TOOLS);
    expect(screen.getByText("mcp_calendar_list")).toBeTruthy();
    expect(screen.queryByText("mcp_notes_search")).toBeNull();
  });

  it("sets approval for one server only", () => {
    const seen = setup(
      { ...emptyGrant(), extras: ["mcp_notes_search"] },
      [],
      {},
      MCP_TOOLS,
    );

    open("MCP");
    fireEvent.click(
      choices("Approval for notes tools").getByLabelText("Don't ask"),
    );
    expect(seen.approval).toEqual({
      mcp_notes_search: false,
      mcp_notes_write: false,
    });
  });

  it("keeps the same tools when switching between allow and deny", () => {
    const seen = setup({ ...emptyGrant(), groups: ["web"] });

    fireEvent.click(screen.getByText("All except unticked"));
    expect(seen.grant.mode).toBe("deny");
    expect(screen.getByText("2 of 2")).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
  });

  it("lists names with no tool and removes them", () => {
    const seen = setup({ ...emptyGrant(), extras: ["gone_tool"] });

    expect(screen.getByText("gone_tool (missing)")).toBeTruthy();
    fireEvent.click(screen.getByText("Remove"));
    expect(seen.grant.extras).toEqual([]);
    expect(screen.queryByText("gone_tool (missing)")).toBeNull();
  });
});

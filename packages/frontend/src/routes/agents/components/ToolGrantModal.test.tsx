import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolInfo, ToolApprovalInfo } from "../../../api";
import { emptyGrant, type ToolGrant } from "../../../lib/tool-grant";
import { ToolGrantModal } from "./ToolGrantModal";

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
  tool("web_search", "web"),
  tool("read_webpage", "web"),
  tool("mcp_notes_search", "mcp"),
  tool("mcp_calendar_list", "mcp"),
];

const approvals: ToolApprovalInfo[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  group: t.group,
  alwaysOn: t.alwaysOn,
  ask: false,
  fixed: t.name === "files_edit",
}));

function setup(
  grant: ToolGrant = emptyGrant(),
  approval: Record<string, boolean> = {},
  newTools: string[] = [],
) {
  const onApply = vi.fn();
  const onClose = vi.fn();

  render(
    <MantineProvider>
      <ToolGrantModal
        agentName="Dr. Woodland"
        grant={grant}
        approval={approval}
        tools={TOOLS}
        approvals={approvals}
        newTools={new Set(newTools)}
        onApply={onApply}
        onClose={onClose}
      />
    </MantineProvider>,
  );

  return { onApply, onClose };
}

describe("ToolGrantModal", () => {
  it("applies its changes on Done", () => {
    const { onApply, onClose } = setup();

    fireEvent.click(screen.getByLabelText("Web tools"));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0].groups).toEqual(["web"]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("throws its changes away on Cancel", () => {
    const { onApply, onClose } = setup();

    fireEvent.click(screen.getByLabelText("Web tools"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("opens on the group that has something new", () => {
    setup(emptyGrant(), {}, ["web_search"]);
    expect(screen.getByText("0 of 2 allowed")).toBeTruthy();
    expect(screen.getByText("web_search")).toBeTruthy();
    expect(screen.queryByText("files_edit")).toBeNull();
  });

  it("opens on the first allowed group when nothing is new", () => {
    setup({ ...emptyGrant(), groups: ["web"] });
    expect(screen.getByText("web_search")).toBeTruthy();
  });

  it("allows and clears a whole group", () => {
    const { onApply } = setup({ ...emptyGrant(), groups: ["web"] });

    fireEvent.click(screen.getByRole("button", { name: "Allow none" }));
    expect(screen.getByText("0 of 2 allowed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow all" }));
    expect(screen.getByText("2 of 2 allowed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onApply.mock.calls[0]?.[0].groups).toEqual(["web"]);
  });

  it("sets approval for one tool", () => {
    const { onApply } = setup({ ...emptyGrant(), groups: ["web"] });

    fireEvent.click(
      within(
        screen.getByRole("radiogroup", { name: "Approval for web_search" }),
      ).getByLabelText("Ask"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onApply.mock.calls[0]?.[1]).toEqual({ web_search: true });
  });

  it("shows a tool that always asks as fixed", () => {
    setup({ ...emptyGrant(), groups: ["files"] });
    expect(screen.getByText("Always asks")).toBeTruthy();
    expect(
      screen.queryByRole("radiogroup", { name: "Approval for files_edit" }),
    ).toBeNull();
  });

  it("lists MCP tools under their server", () => {
    setup({ ...emptyGrant(), groups: ["mcp"] });
    fireEvent.click(screen.getByRole("button", { name: /^MCP/ }));
    expect(screen.getByText("notes")).toBeTruthy();
    expect(screen.getByText("calendar")).toBeTruthy();
    expect(screen.getByText("mcp_notes_search")).toBeTruthy();
  });
});

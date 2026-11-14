import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type ToolView } from "../../../api";
import { ToolSettings } from "./ToolSettings";

const tool = (name: string, over: Partial<ToolView> = {}): ToolView => ({
  name,
  description: `${name} does a thing.`,
  group: "web",
  askByDefault: false,
  ask: false,
  fixed: false,
  alwaysOn: false,
  alwaysOnByDefault: false,
  off: false,
  needsReview: false,
  usedByAgents: [],
  ...over,
});

function renderSection(tools: ToolView[]) {
  vi.spyOn(api, "listTools").mockResolvedValue(tools);

  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <ModalsProvider>
          <ToolSettings />
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ToolSettings", () => {
  it("groups tools under headers", async () => {
    renderSection([tool("web_search"), tool("files_edit", { group: "files" })]);
    expect(await screen.findByText("web_search")).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByText("Web")).toBeTruthy();
  });

  it("saves a tool's always-on switch as it changes", async () => {
    const set = vi
      .spyOn(api, "setToolAlwaysOn")
      .mockResolvedValue(tool("web_search", { alwaysOn: true }));

    renderSection([tool("web_search")]);
    fireEvent.click(await screen.findByLabelText("web_search: always on"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("web_search", true));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("web_search: always on") as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
  });

  it("saves a tool's ask switch", async () => {
    const set = vi
      .spyOn(api, "setToolAsks")
      .mockResolvedValue(tool("web_search", { ask: true }));

    renderSection([tool("web_search")]);
    fireEvent.click(
      await screen.findByLabelText("web_search: ask before running"),
    );
    await waitFor(() => expect(set).toHaveBeenCalledWith("web_search", true));
  });

  it("locks the ask switch of a tool that always asks", async () => {
    renderSection([tool("files_kill", { fixed: true, ask: true })]);
    const box = (await screen.findByLabelText(
      "files_kill: ask before running",
    )) as HTMLInputElement;

    expect(box.disabled).toBe(true);
  });

  it("switches off a tool no agent lists straight away", async () => {
    const set = vi
      .spyOn(api, "setToolOff")
      .mockResolvedValue(tool("web_search", { off: true }));

    renderSection([tool("web_search")]);
    fireEvent.click(await screen.findByLabelText("web_search: off"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("web_search", true));
  });

  it("asks first, naming the agents, before switching off a listed tool", async () => {
    const set = vi
      .spyOn(api, "setToolOff")
      .mockResolvedValue(tool("web_search", { off: true }));

    renderSection([
      tool("web_search", { usedByAgents: ["Researcher", "Editor"] }),
    ]);
    fireEvent.click(await screen.findByLabelText("web_search: off"));
    expect(await screen.findByText("Editor, Researcher")).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Switch off"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("web_search", true));
  });

  it("does not switch off when the question is cancelled", async () => {
    const set = vi.spyOn(api, "setToolOff");

    renderSection([tool("web_search", { usedByAgents: ["Researcher"] })]);
    fireEvent.click(await screen.findByLabelText("web_search: off"));
    fireEvent.click(await screen.findByText("Cancel"));
    expect(set).not.toHaveBeenCalled();
  });

  it("sets a whole group from its header", async () => {
    const set = vi
      .spyOn(api, "setToolGroup")
      .mockResolvedValue([
        tool("web_search", { alwaysOn: true }),
        tool("read_webpage", { alwaysOn: true }),
      ]);

    renderSection([tool("web_search"), tool("read_webpage")]);
    fireEvent.click(await screen.findByLabelText("Always on for Web tools"));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith("web", { alwaysOn: true }),
    );
  });

  it("shows a group's mixed state as indeterminate", async () => {
    renderSection([tool("web_search", { off: true }), tool("read_webpage")]);
    const head = (await screen.findByLabelText(
      "Off for Web tools",
    )) as HTMLInputElement;

    expect(head.indeterminate).toBe(true);
  });
});

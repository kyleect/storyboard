import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type McpServerView } from "../../../api";
import { McpServers } from "./McpServers";

const server = (over: Partial<McpServerView> = {}): McpServerView => ({
  id: "s1",
  name: "files",
  enabled: true,
  config: { transport: "stdio", command: "npx", args: ["-y", "srv"], env: {} },
  createdAt: "2026-11-06T00:00:00Z",
  updatedAt: "2026-11-06T00:00:00Z",
  status: {
    state: "connected",
    error: null,
    tools: [{ name: "mcp_files_echo", serverName: "echo", description: "" }],
  },
  ...over,
});

function renderSection(servers: McpServerView[]) {
  vi.spyOn(api, "listMcpServers").mockResolvedValue(servers);

  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <ModalsProvider>
          <McpServers />
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("McpServers", () => {
  it("shows a server with its status, command and tool count", async () => {
    renderSection([server()]);
    expect(await screen.findByText("files")).toBeTruthy();
    expect(screen.getByText("connected")).toBeTruthy();
    expect(screen.getByText("1 tool")).toBeTruthy();
    expect(screen.getByText("npx -y srv")).toBeTruthy();
  });

  it("shows why a server failed", async () => {
    renderSection([
      server({
        status: { state: "failed", error: "connection refused", tools: [] },
      }),
    ]);
    expect(await screen.findByText("failed")).toBeTruthy();
    expect(screen.getByText("connection refused")).toBeTruthy();
  });

  it("says when there are none", async () => {
    renderSection([]);
    expect(await screen.findByText("No MCP servers.")).toBeTruthy();
  });

  it("turns a server off with its switch, keeping its settings", async () => {
    const save = vi
      .spyOn(api, "saveMcpServer")
      .mockResolvedValue(server({ enabled: false }));

    renderSection([server()]);
    fireEvent.click(await screen.findByLabelText("files: enabled"));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("s1", {
        name: "files",
        enabled: false,
        config: server().config,
      }),
    );
  });

  it("reconnects a server", async () => {
    const reconnect = vi
      .spyOn(api, "reconnectMcpServer")
      .mockResolvedValue(server());

    renderSection([server()]);
    fireEvent.click(await screen.findByText("Reconnect"));
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith("s1"));
  });

  it("adds a stdio server from the form", async () => {
    const create = vi.spyOn(api, "createMcpServer").mockResolvedValue(server());

    renderSection([]);
    fireEvent.click(await screen.findByText("Add server"));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "files" },
    });
    fireEvent.change(screen.getByLabelText(/^Command/), {
      target: { value: "npx" },
    });
    fireEvent.change(screen.getByLabelText(/^Arguments/), {
      target: { value: "-y\nsrv" },
    });
    fireEvent.change(screen.getByLabelText(/^Environment/), {
      target: { value: "TOKEN=a=b" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "files",
        enabled: true,
        config: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "srv"],
          env: { TOKEN: "a=b" },
        },
      }),
    );
  });

  it("adds an http server from the form", async () => {
    const create = vi.spyOn(api, "createMcpServer").mockResolvedValue(server());

    renderSection([]);
    fireEvent.click(await screen.findByText("Add server"));
    fireEvent.click(screen.getByText("Remote (HTTP)"));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "web" },
    });
    fireEvent.change(screen.getByLabelText(/^URL/), {
      target: { value: "https://example.com/mcp" },
    });
    fireEvent.change(screen.getByLabelText(/^Headers/), {
      target: { value: "Authorization: Bearer x" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "web",
        enabled: true,
        config: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer x" },
        },
      }),
    );
  });

  it("explains a line that is not NAME=value instead of saving", async () => {
    const create = vi.spyOn(api, "createMcpServer");

    renderSection([]);
    fireEvent.click(await screen.findByText("Add server"));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "files" },
    });
    fireEvent.change(screen.getByLabelText(/^Command/), {
      target: { value: "npx" },
    });
    fireEvent.change(screen.getByLabelText(/^Environment/), {
      target: { value: "oops" },
    });
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText(/not in the form NAME=value/)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("shows the server's error from the backend", async () => {
    vi.spyOn(api, "createMcpServer").mockRejectedValue(
      new Error('There is already an MCP server named "files".'),
    );
    renderSection([]);
    fireEvent.click(await screen.findByText("Add server"));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "files" },
    });
    fireEvent.change(screen.getByLabelText(/^Command/), {
      target: { value: "npx" },
    });
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText(/already an MCP server/)).toBeTruthy();
  });
});

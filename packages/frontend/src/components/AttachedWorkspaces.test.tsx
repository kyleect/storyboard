import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Workspace, type WorkspaceAttachment } from "../api";
import { AttachedWorkspaces } from "./AttachedWorkspaces";

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  name: "Book",
  path: "/Users/me/Book",
  writable: false,
  createdAt: "2026-11-06T00:00:00Z",
  updatedAt: "2026-11-06T00:00:00Z",
  deleted: false,
  ticks: [],
  ...over,
});

function renderWith(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <ModalsProvider>{ui}</ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AttachedWorkspaces", () => {
  const attachment = (
    over: Partial<WorkspaceAttachment> = {},
  ): WorkspaceAttachment => ({
    workspace: workspace(),
    from: "session",
    readOnly: false,
    effectiveWritable: false,
    ...over,
  });

  it("shows what a session has, its project's marked and not detachable", async () => {
    vi.spyOn(api, "listAttachedWorkspaces").mockResolvedValue([
      attachment({ from: "project", workspace: workspace({ name: "Shared" }) }),
      attachment({ workspace: workspace({ id: "w2", name: "Mine" }) }),
    ]);
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([]);
    renderWith(<AttachedWorkspaces owner="sessions" id="s1" />);
    expect(await screen.findByText("Shared")).toBeTruthy();
    expect(screen.getByText("from the project")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Detach" })).toHaveLength(1);
  });

  it("attaches a workspace, read-only when asked", async () => {
    vi.spyOn(api, "listAttachedWorkspaces").mockResolvedValue([]);
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([workspace()]);
    const attach = vi.spyOn(api, "attachWorkspace").mockResolvedValue({});

    renderWith(<AttachedWorkspaces owner="projects" id="p1" />);
    expect(await screen.findByText("None attached.")).toBeTruthy();
    fireEvent.click(screen.getByPlaceholderText("Attach a workspace"));
    fireEvent.click(await screen.findByText("Book"));
    fireEvent.click(screen.getByLabelText("Read-only here"));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() =>
      expect(attach).toHaveBeenCalledWith("projects", "p1", "w1", true),
    );
  });

  it("detaches", async () => {
    vi.spyOn(api, "listAttachedWorkspaces").mockResolvedValue([attachment()]);
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([workspace()]);
    const detach = vi.spyOn(api, "detachWorkspace").mockResolvedValue({});

    renderWith(<AttachedWorkspaces owner="sessions" id="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Detach" }));
    await waitFor(() =>
      expect(detach).toHaveBeenCalledWith("sessions", "s1", "w1"),
    );
  });

  it("offers nothing to change when disabled", async () => {
    vi.spyOn(api, "listAttachedWorkspaces").mockResolvedValue([attachment()]);
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([
      workspace({ id: "w9", name: "Other" }),
    ]);
    renderWith(<AttachedWorkspaces owner="sessions" id="s1" disabled />);
    const detach = (await screen.findByRole("button", {
      name: "Detach",
    })) as HTMLButtonElement;

    expect(detach.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
  });
});

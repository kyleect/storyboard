import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Workspace, type WorkspaceGrant } from "../../api";
import { WorkspacesPage } from "./Workspaces";

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

function renderPage(
  list: Workspace[],
  grants: WorkspaceGrant[] = [],
  trash: Workspace[] = [],
) {
  vi.spyOn(api, "listWorkspaces").mockImplementation((deleted = false) =>
    Promise.resolve(deleted ? trash : list),
  );
  vi.spyOn(api, "listWorkspaceGrants").mockResolvedValue(grants);

  return renderWith(<WorkspacesPage />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkspacesPage", () => {
  it("shows each workspace with its folder and whether it can be changed", async () => {
    renderPage([
      workspace(),
      workspace({
        id: "w2",
        name: "Refs",
        path: "/Users/me/Refs",
        writable: true,
      }),
    ]);
    expect(await screen.findByText("Book")).toBeTruthy();
    expect(screen.getByText("/Users/me/Book")).toBeTruthy();
    expect(screen.getByText("read-only")).toBeTruthy();
    expect(screen.getByText("writable")).toBeTruthy();
  });

  it("says when there are none", async () => {
    renderPage([]);
    expect(await screen.findByText("No workspaces.")).toBeTruthy();
  });

  it("creates one from the form", async () => {
    const create = vi
      .spyOn(api, "createWorkspace")
      .mockResolvedValue(workspace());

    renderPage([]);
    fireEvent.click(
      await screen.findByRole("button", { name: "New workspace" }),
    );
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Novel" },
    });
    fireEvent.change(screen.getByLabelText(/Folder/), {
      target: { value: "/Users/me/Novel" },
    });
    fireEvent.click(screen.getByLabelText(/Writable/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Novel",
        path: "/Users/me/Novel",
        writable: true,
      }),
    );
  });

  it("shows the server's reason when a workspace cannot be saved", async () => {
    vi.spyOn(api, "createWorkspace").mockRejectedValue(
      new Error("There is no folder at /nope."),
    );
    renderPage([]);
    fireEvent.click(
      await screen.findByRole("button", { name: "New workspace" }),
    );
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText(/Folder/), {
      target: { value: "/nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("There is no folder at /nope."),
    ).toBeTruthy();
  });

  it("picks a folder from the browser", async () => {
    vi.spyOn(api, "listDirs").mockImplementation((path) =>
      Promise.resolve(
        path === "/Users/me"
          ? { path, parent: "/Users", dirs: ["Book", "Music"] }
          : { path: "/Users/me/Book", parent: "/Users/me", dirs: [] },
      ),
    );
    renderPage([]);
    fireEvent.click(
      await screen.findByRole("button", { name: "New workspace" }),
    );
    fireEvent.change(screen.getByLabelText(/Folder/), {
      target: { value: "/Users/me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    fireEvent.click(await screen.findByText("Book"));
    await screen.findByText("No folders here.");
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    await waitFor(() =>
      expect((screen.getByLabelText(/Folder/) as HTMLInputElement).value).toBe(
        "/Users/me/Book",
      ),
    );
  });

  it("moves one to the trash, and restores it from the trash", async () => {
    const trash = vi
      .spyOn(api, "trashWorkspace")
      .mockResolvedValue(workspace({ deleted: true }));
    const restore = vi
      .spyOn(api, "restoreWorkspace")
      .mockResolvedValue(workspace());

    renderPage([workspace()], [], [workspace({ deleted: true })]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Move to trash" }),
    );
    await waitFor(() => expect(trash).toHaveBeenCalledWith("w1"));
    fireEvent.click(screen.getByLabelText("Show the trash"));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("w1"));
  });

  it("lists the always-allowed tools and removes one", async () => {
    const revoke = vi.spyOn(api, "revokeWorkspaceGrant").mockResolvedValue({});

    renderPage(
      [workspace()],
      [{ tool: "workspace_write", workspaceId: "w1", workspaceName: "Book" }],
    );
    expect(await screen.findByText("workspace_write")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith("workspace_write", "w1"),
    );
  });
});

describe("searched parts", () => {
  const entry = (
    name: string,
    kind: "file" | "folder",
    state: "all" | "some" | "none",
    folder = "",
  ) => ({
    name,
    kind,
    state,
    path: folder === "" ? name : `${folder}/${name}`,
  });

  function open() {
    vi.spyOn(api, "getWorkspaceIndex").mockResolvedValue({
      ticks: ["notes"],
      status: {
        files: 3,
        chunks: 5,
        scanning: false,
        truncated: false,
        unavailable: false,
        lastScan: "2026-11-07T00:00:00Z",
      },
    });
    vi.spyOn(api, "getWorkspaceTree").mockImplementation((_id, path = "") =>
      Promise.resolve({
        path,
        entries:
          path === ""
            ? [
                entry("notes", "folder", "all"),
                entry("drafts", "folder", "some"),
                entry("ch1.md", "file", "none"),
              ]
            : [entry("idea.md", "file", "all", path)],
      }),
    );
    renderPage([workspace({ ticks: ["notes"] })]);

    return screen.findByRole("button", { name: "Searched parts" });
  }

  it("shows how many parts are chosen, and the tree with ticks when opened", async () => {
    fireEvent.click(await open());
    expect(await screen.findByLabelText("notes/")).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByLabelText("ch1.md")).toHaveProperty("checked", false);
    expect(screen.getByLabelText("drafts/")).toHaveProperty(
      "indeterminate",
      true,
    );
    expect(await screen.findByText("3 files searchable.")).toBeTruthy();
  });

  it("ticks and unticks a path", async () => {
    const toggle = vi
      .spyOn(api, "toggleWorkspaceTick")
      .mockResolvedValue({ ticks: [], status: null });

    fireEvent.click(await open());
    fireEvent.click(await screen.findByLabelText("ch1.md"));
    await waitFor(() =>
      expect(toggle).toHaveBeenCalledWith("w1", "ch1.md", true),
    );
    fireEvent.click(screen.getByLabelText("notes/"));
    await waitFor(() =>
      expect(toggle).toHaveBeenCalledWith("w1", "notes", false),
    );
    fireEvent.click(screen.getByLabelText("drafts/"));
    await waitFor(() =>
      expect(toggle).toHaveBeenCalledWith("w1", "drafts", true),
    );
  });

  it("opens a folder to show what is in it", async () => {
    fireEvent.click(await open());
    fireEvent.click(await screen.findByRole("button", { name: "Open notes" }));
    expect(await screen.findByLabelText("idea.md")).toBeTruthy();
  });

  it("ticks the whole folder, and rescans", async () => {
    const toggle = vi
      .spyOn(api, "toggleWorkspaceTick")
      .mockResolvedValue({ ticks: [""], status: null });
    const rescan = vi.spyOn(api, "rescanWorkspace").mockResolvedValue({});

    fireEvent.click(await open());
    fireEvent.click(await screen.findByLabelText("The whole folder"));
    await waitFor(() => expect(toggle).toHaveBeenCalledWith("w1", "", true));
    fireEvent.click(await screen.findByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(rescan).toHaveBeenCalledWith("w1"));
  });

  it("says when the folder is not there", async () => {
    vi.spyOn(api, "getWorkspaceIndex").mockResolvedValue({
      ticks: ["notes"],
      status: {
        files: 3,
        chunks: 5,
        scanning: false,
        truncated: false,
        unavailable: true,
        lastScan: null,
      },
    });
    vi.spyOn(api, "getWorkspaceTree").mockResolvedValue({
      path: "",
      entries: [],
    });
    renderPage([workspace({ ticks: ["notes"] })]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Searched parts" }),
    );
    expect(
      await screen.findByText(/The folder is not there; the index is kept/),
    ).toBeTruthy();
  });
});

import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  type FileScope,
  type Workspace,
  type WorkspaceGrant,
} from "../../api";
import { NewWorkspace, WorkspaceSettings } from "./WorkspaceTab";

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  name: "Book",
  path: "/Users/me/Book",
  writable: false,
  scope: "global",
  ownerId: null,
  temporary: false,
  respectGitignore: true,
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

function renderPage(w: Workspace, grants: WorkspaceGrant[] = []) {
  vi.spyOn(api, "listWorkspaceGrants").mockResolvedValue(grants);
  vi.spyOn(api, "listWorkspaceFiles").mockResolvedValue({
    entries: [],
    truncated: false,
    unavailable: false,
  });

  return renderWith(
    <WorkspaceSettings
      workspace={w}
      scope={{ scope: "global" }}
      onClose={() => {}}
    />,
  );
}

function renderNew(
  scope: FileScope,
  temporary = false,
  onDone: () => void = () => {},
) {
  return renderWith(
    <NewWorkspace
      scope={scope}
      temporary={temporary}
      onDone={onDone}
      onClose={() => {}}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a workspace's tab", () => {
  it("shows its settings, and saves a change", async () => {
    const save = vi
      .spyOn(api, "saveWorkspace")
      .mockResolvedValue(workspace({ writable: true }));

    renderPage(workspace({ writable: false }));
    expect(await screen.findByDisplayValue("Book")).toBeTruthy();
    expect(screen.getByDisplayValue("/Users/me/Book")).toBeTruthy();
    expect(screen.getByText(/Seen by every session/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Writable/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("w1", {
        name: "Book",
        path: "/Users/me/Book",
        writable: true,
        respectGitignore: true,
      }),
    );
  });

  it("keeps the folder of a temporary workspace fixed", async () => {
    renderPage(workspace({ scope: "session", ownerId: "s1", temporary: true }));
    expect(
      ((await screen.findByLabelText(/Folder/)) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Browse" })).toBeNull();
    expect(screen.getByText(/Seen by this session/)).toBeTruthy();
  });

  it("says when the folder is not there, or is large", async () => {
    vi.spyOn(api, "listWorkspaceGrants").mockResolvedValue([]);
    vi.spyOn(api, "listWorkspaceFiles").mockResolvedValue({
      entries: [],
      truncated: false,
      unavailable: true,
    });
    renderWith(
      <WorkspaceSettings
        workspace={workspace()}
        scope={{ scope: "global" }}
        onClose={() => {}}
      />,
    );
    expect(
      await screen.findByText("The folder is not there right now."),
    ).toBeTruthy();
  });

  it("lists the always-allowed tools of this workspace and removes one", async () => {
    const revoke = vi.spyOn(api, "revokeWorkspaceGrant").mockResolvedValue({});

    renderPage(workspace(), [
      { tool: "workspace_write", workspaceId: "w1", workspaceName: "Book" },
      { tool: "workspace_edit", workspaceId: "w2", workspaceName: "Refs" },
    ]);
    expect(await screen.findByText("workspace_write")).toBeTruthy();
    expect(screen.queryByText("workspace_edit")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith("workspace_write", "w1"),
    );
  });
});

describe("respecting .gitignore", () => {
  it("is on for a workspace, and saved when turned off", async () => {
    const save = vi.spyOn(api, "saveWorkspace").mockResolvedValue(workspace());

    renderPage(workspace());
    const sw = (await screen.findByLabelText(
      /Respect .gitignore/,
    )) as HTMLInputElement;

    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("w1", {
        name: "Book",
        path: "/Users/me/Book",
        writable: false,
        respectGitignore: false,
      }),
    );
  });

  it("is on by default for a new workspace", async () => {
    const create = vi
      .spyOn(api, "createWorkspace")
      .mockResolvedValue(workspace());

    renderNew({ scope: "global" });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText(/Folder/), {
      target: { value: "/a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        { scope: "global" },
        { name: "A", path: "/a", writable: false, respectGitignore: true },
      ),
    );
  });
});

describe("a new workspace", () => {
  it("is created at the scope of its group", async () => {
    const create = vi
      .spyOn(api, "createWorkspace")
      .mockResolvedValue(workspace());
    const done = vi.fn();

    renderNew({ scope: "project", id: "p1" }, false, done);
    expect(
      screen.getByText(/Seen by every session in this project/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Novel" },
    });
    fireEvent.change(screen.getByLabelText(/Folder/), {
      target: { value: "/Users/me/Novel" },
    });
    fireEvent.click(screen.getByLabelText(/Writable/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        { scope: "project", id: "p1" },
        {
          name: "Novel",
          path: "/Users/me/Novel",
          writable: true,
          respectGitignore: true,
        },
      ),
    );
    await waitFor(() => expect(done).toHaveBeenCalled());
  });

  it("makes a temporary workspace from a name alone", async () => {
    const create = vi
      .spyOn(api, "createTemporaryWorkspace")
      .mockResolvedValue(workspace({ temporary: true }));

    renderNew({ scope: "session", id: "s1" }, true);
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "scratch" },
    });
    expect(screen.queryByLabelText(/Folder/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("s1", "scratch"));
  });

  it("shows the server's reason when a workspace cannot be saved", async () => {
    vi.spyOn(api, "createWorkspace").mockRejectedValue(
      new Error("There is no folder at /nope."),
    );
    renderNew({ scope: "global" });
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
    renderNew({ scope: "global" });
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
    renderPage(workspace({ ticks: ["notes"] }));

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

  it("does not let an ignored file be ticked, or one the page's scope hides", async () => {
    vi.spyOn(api, "getWorkspaceIndex").mockResolvedValue({
      ticks: [""],
      status: null,
    });
    const tree = vi.spyOn(api, "getWorkspaceTree").mockResolvedValue({
      path: "",
      entries: [
        {
          name: "build",
          path: "build",
          kind: "folder",
          state: "all",
          ignored: true,
          hidden: "none",
        },
        {
          name: "private",
          path: "private",
          kind: "folder",
          state: "all",
          hidden: "all",
        },
        {
          name: "ch1.md",
          path: "ch1.md",
          kind: "file",
          state: "all",
          hidden: "none",
        },
      ],
    });

    renderPage(workspace({ ticks: [""] }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Searched parts" }),
    );
    const build = (await screen.findByLabelText("build/")) as HTMLInputElement;
    const hidden = screen.getByLabelText("private/") as HTMLInputElement;
    const normal = screen.getByLabelText("ch1.md") as HTMLInputElement;

    expect(build.checked).toBe(false);
    expect(build.disabled).toBe(true);
    expect(hidden.checked).toBe(false);
    expect(hidden.disabled).toBe(true);
    expect(normal.checked).toBe(true);
    expect(screen.getByText("ignored")).toBeTruthy();
    expect(screen.getByText("hidden here")).toBeTruthy();
    expect(tree).toHaveBeenCalledWith("w1", "", { scope: "global" });
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
    renderPage(workspace({ ticks: ["notes"] }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Searched parts" }),
    );
    expect(
      await screen.findByText(/The folder is not there; the index is kept/),
    ).toBeTruthy();
  });
});

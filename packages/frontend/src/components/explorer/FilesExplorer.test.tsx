import { EditorView } from "@codemirror/view";
import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  type FileDetail,
  type FileScope,
  type Project,
  type StoredFile,
} from "../../api";
import { fileKeys, projectKeys } from "../../queries";
import { FilesExplorer } from "./FilesExplorer";
import { ValueView } from "./FileViews";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
beforeEach(() => localStorage.clear());

const session: FileScope = { scope: "session", id: "s1" };
const project: FileScope = { scope: "project", id: "p1" };
const global: FileScope = { scope: "global" };

const at = "2026-11-11T00:00:00Z";
const cat: StoredFile = {
  key: "cat.png",
  mediaType: "image/png",
  value: "",
  blob: { hash: "h-cat", size: 2048 },
  updatedAt: at,
  deleted: false,
};
const note: StoredFile = {
  key: "drafts/notes.md",
  mediaType: "text/markdown",
  value: "# Hi",
  updatedAt: at,
  deleted: false,
};
const plan: StoredFile = {
  key: "plan.txt",
  mediaType: "text/plain",
  value: "the plan",
  updatedAt: at,
  deleted: false,
};
const rules: StoredFile = {
  key: "rules.txt",
  mediaType: "text/plain",
  value: "house rules",
  updatedAt: at,
  deleted: false,
};
const bible: StoredFile = {
  key: "bible.txt",
  mediaType: "text/plain",
  value: "the story bible",
  updatedAt: at,
  deleted: false,
};

const FILES: Record<string, StoredFile[]> = {
  session: [cat, note, plan],
  project: [rules],
  global: [bible],
};

const detail = (e: StoredFile): FileDetail => ({ ...e, versions: [] });

function show(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MantineProvider env="test">
          <ModalsProvider>{ui}</ModalsProvider>
        </MantineProvider>
      </QueryClientProvider>,
    ),
  };
}

function typeInEditor(text: string) {
  const dom = document.querySelector<HTMLElement>(".cm-editor");
  if (!dom) throw new Error("no editor is open");
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("no editor view");
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  });
}

function mockApi() {
  vi.spyOn(api, "listFiles").mockImplementation(async (s) => {
    return FILES[s.scope] ?? [];
  });
  vi.spyOn(api, "listFolders").mockImplementation(async (s) =>
    s.scope === "session" ? ["drafts", "ideas"] : [],
  );
  vi.spyOn(api, "getFile").mockImplementation(async (s, key) => {
    const e = (FILES[s.scope] ?? []).find((f) => f.key === key);
    if (!e) throw new Error("not found");
    return detail(e);
  });
  vi.spyOn(api, "blobUrl").mockResolvedValue("blob:cat");
}

describe("ValueView of a binary file", () => {
  it("shows an image from its bytes, with its type and size", async () => {
    vi.spyOn(api, "blobUrl").mockResolvedValue("blob:cat");
    show(
      <ValueView
        mediaType="image/png"
        value=""
        blob={{ hash: "h-cat", size: 2048 }}
      />,
    );
    expect((await screen.findByAltText("Preview")).getAttribute("src")).toBe(
      "blob:cat",
    );
    expect(screen.getByText("image/png, 2 KB")).toBeTruthy();
  });

  it("plays audio", async () => {
    vi.spyOn(api, "blobUrl").mockResolvedValue("blob:voice");
    const { container } = show(
      <ValueView
        mediaType="audio/wav"
        value=""
        blob={{ hash: "h-voice", size: 3 * 1024 * 1024 }}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("audio")?.getAttribute("src")).toBe(
        "blob:voice",
      ),
    );
    expect(screen.getByText("audio/wav, 3.0 MB")).toBeTruthy();
  });

  it("says when the bytes cannot be loaded", async () => {
    vi.spyOn(api, "blobUrl").mockRejectedValue(new Error("gone"));
    show(
      <ValueView
        mediaType="image/png"
        value=""
        blob={{ hash: "h-x", size: 1 }}
      />,
    );
    expect(
      await screen.findByText(/Could not load the file: gone/),
    ).toBeTruthy();
  });
});

describe("the roots of the tree", () => {
  beforeEach(mockApi);

  it("shows Session, Project and Global on a session page, with their files", async () => {
    show(<FilesExplorer page={session} projectId="p1" />);
    expect(await screen.findByText("Session")).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("Global")).toBeTruthy();
    expect(await screen.findByText("plan.txt")).toBeTruthy();
    expect(screen.getByText("rules.txt")).toBeTruthy();
    expect(screen.getByText("bible.txt")).toBeTruthy();
    expect(screen.getByText("drafts")).toBeTruthy();
    expect(screen.queryByText("notes.md")).toBeNull();
    fireEvent.click(screen.getByText("drafts"));
    expect(await screen.findByText("notes.md")).toBeTruthy();
  });

  it("has no Project root for a standalone session", async () => {
    show(<FilesExplorer page={session} projectId={null} />);
    await screen.findByText("bible.txt");
    expect(screen.queryByText("Project")).toBeNull();
    expect(screen.getByText("Session")).toBeTruthy();
  });

  it("shows only Global on the global page, and Project and Global on a project page", async () => {
    const first = show(<FilesExplorer page={global} />);
    await screen.findByText("bible.txt");
    expect(screen.queryByText("Session")).toBeNull();
    expect(screen.queryByText("Project")).toBeNull();
    first.unmount();
    show(<FilesExplorer page={project} />);
    await screen.findByText("rules.txt");
    expect(screen.getByText("Global")).toBeTruthy();
    expect(screen.queryByText("Session")).toBeNull();
  });

  it("asks for deleted files when Show deleted is turned on", async () => {
    show(<FilesExplorer page={global} />);
    await screen.findByText("bible.txt");
    const list = vi.mocked(api.listFiles);
    expect(list).toHaveBeenCalledWith(global, false);
    fireEvent.click(screen.getByRole("button", { name: "Show deleted files" }));
    await waitFor(() => expect(list).toHaveBeenCalledWith(global, true));
  });
});

describe("what the tree remembers and shows", () => {
  beforeEach(mockApi);

  const remember = (view: object) =>
    localStorage.setItem(
      "harness.files.session.s1",
      JSON.stringify({
        tabs: [],
        active: null,
        expanded: {},
        width: 280,
        showDeleted: false,
        ...view,
      }),
    );

  it("opens the folders that were open the last time", async () => {
    remember({ expanded: { "session|folder|drafts": true } });
    show(<FilesExplorer page={session} projectId="p1" />);
    expect(await screen.findByText("notes.md")).toBeTruthy();
  });

  it("opens the folders above the file in the active tab", async () => {
    const tab = {
      kind: "file",
      root: "session",
      key: "drafts/notes.md",
      transient: false,
    };
    remember({ tabs: [tab], active: "file|session|drafts/notes.md" });
    show(<FilesExplorer page={session} projectId="p1" />);
    expect(await screen.findByText("notes.md")).toBeTruthy();
    expect(screen.getByRole("treeitem", { selected: true })).toBeTruthy();
  });

  it("reveals the file when its tab is chosen", async () => {
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("drafts"));
    fireEvent.doubleClick(await screen.findByText("notes.md"));
    fireEvent.doubleClick(screen.getByText("plan.txt"));
    fireEvent.click(screen.getByText("drafts"));
    await waitFor(() => expect(screen.queryByText("notes.md")).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: /notes.md/ }));
    expect(await screen.findByText("notes.md")).toBeTruthy();
  });

  it("says why when the files cannot be loaded", async () => {
    vi.spyOn(api, "listFiles").mockRejectedValue(new Error("no connection"));
    show(<FilesExplorer page={global} />);
    expect(await screen.findByText("no connection")).toBeTruthy();
  });
});

describe("tabs", () => {
  beforeEach(mockApi);

  it("opens a file in a tab on a single click, replacing the italic tab on the next", async () => {
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("plan.txt"));
    const tabs = () => screen.getAllByRole("tab").map((t) => t.textContent);
    await waitFor(() => expect(tabs()).toEqual(["plan.txt · Session"]));
    expect(screen.getByRole("tab").style.fontStyle).toBe("italic");
    fireEvent.click(screen.getByText("rules.txt"));
    await waitFor(() => expect(tabs()).toEqual(["rules.txt · Project"]));
  });

  it("keeps a tab opened by double click", async () => {
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.doubleClick(await screen.findByText("plan.txt"));
    fireEvent.click(screen.getByText("rules.txt"));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.getAllByRole("tab")[0]?.style.fontStyle).not.toBe("italic");
  });

  it("closes a tab with its close button", async () => {
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.doubleClick(await screen.findByText("plan.txt"));
    await screen.findByRole("tab");
    fireEvent.click(
      screen.getByRole("button", { name: "Close plan.txt · Session" }),
    );
    await waitFor(() => expect(screen.queryByRole("tab")).toBeNull());
    expect(screen.getByText("Open a file from the tree.")).toBeTruthy();
  });

  it("remembers the open tabs for the page", async () => {
    const first = show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.doubleClick(await screen.findByText("plan.txt"));
    await screen.findByRole("tab");
    first.unmount();
    show(<FilesExplorer page={session} projectId="p1" />);
    expect((await screen.findByRole("tab")).textContent).toBe(
      "plan.txt · Session",
    );
  });

  it("tells the same name in two roots apart by the root in the tab", async () => {
    FILES.global = [{ ...bible, key: "plan.txt" }];
    try {
      show(<FilesExplorer page={session} projectId="p1" />);
      const plans = await screen.findAllByText("plan.txt");
      const [inSession, inGlobal] = plans;
      if (!inSession || !inGlobal) throw new Error("expected two plan.txt");
      fireEvent.doubleClick(inSession);
      fireEvent.doubleClick(inGlobal);
      await waitFor(() =>
        expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
          "plan.txt · Session",
          "plan.txt · Global",
        ]),
      );
    } finally {
      FILES.global = [bible];
    }
  });
});

describe("editing", () => {
  beforeEach(mockApi);

  it("saves in place: an unsaved dot on the tab, then Save writes the text", async () => {
    const write = vi
      .spyOn(api, "writeFile")
      .mockResolvedValue(detail({ ...plan, value: "new plan" }));
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("plan.txt"));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    typeInEditor("new plan");
    expect(
      await screen.findByRole("img", { name: "Unsaved changes" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab").style.fontStyle).not.toBe("italic");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        session,
        "plan.txt",
        "text/plain",
        "new plan",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "Unsaved changes" })).toBeNull(),
    );
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("asks before saving a file in a higher scope, and saves on yes", async () => {
    const write = vi
      .spyOn(api, "writeFile")
      .mockResolvedValue(detail({ ...bible, value: "changed" }));
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("bible.txt"));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    typeInEditor("changed");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Save to the Global file/)).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        global,
        "bible.txt",
        "text/plain",
        "changed",
      ),
    );
  });

  it("does not save when the question is declined", async () => {
    const write = vi.spyOn(api, "writeFile");
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("rules.txt"));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    typeInEditor("changed");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Save to the Project file/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("does not ask for a file of the page's own scope", async () => {
    const write = vi.spyOn(api, "writeFile").mockResolvedValue(detail(bible));
    show(<FilesExplorer page={global} />);
    fireEvent.click(await screen.findByText("bible.txt"));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    typeInEditor("changed");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before closing a tab with unsaved changes", async () => {
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("plan.txt"));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    typeInEditor("edited");
    fireEvent.click(
      await screen.findByRole("button", { name: "Close plan.txt · Session" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("tab")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Close plan.txt · Session" }),
    );
    fireEvent.click(
      await within(await screen.findByRole("dialog")).findByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("tab")).toBeNull());
  });

  it("reports whether there are unsaved changes", async () => {
    const onDirtyChange = vi.fn();
    show(
      <FilesExplorer
        page={session}
        projectId="p1"
        onDirtyChange={onDirtyChange}
      />,
    );
    fireEvent.click(await screen.findByText("plan.txt"));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    typeInEditor("edited");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });

  it("warns when the file changed under unsaved text, and can drop the text", async () => {
    const { client } = show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("plan.txt"));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    typeInEditor("mine");
    await screen.findByText("Unsaved changes");
    FILES.session = [cat, note, { ...plan, value: "theirs" }];
    try {
      await act(() =>
        client.invalidateQueries({ queryKey: fileKeys.inScope(session) }),
      );
      expect(
        await screen.findByText(/This file changed since you started editing/),
      ).toBeTruthy();
      expect(document.querySelector(".cm-content")?.textContent).toBe("mine");
      fireEvent.click(screen.getByRole("button", { name: "Discard mine" }));
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toBe(
          "theirs",
        ),
      );
    } finally {
      FILES.session = [cat, note, plan];
    }
  });
});

describe("Markdown", () => {
  beforeEach(mockApi);

  it("opens in the editor, with the rendered view in a tab of its own", async () => {
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("drafts"));
    fireEvent.click(await screen.findByText("notes.md"));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    expect(screen.queryByRole("heading", { name: "Hi" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("heading", { name: "Hi" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "notes.md · Session",
      "Preview notes.md",
    ]);
  });

  it("shows unsaved text in the preview", async () => {
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("drafts"));
    fireEvent.click(await screen.findByText("notes.md"));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    typeInEditor("# Changed");
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(
      await screen.findByRole("heading", { name: "Changed" }),
    ).toBeTruthy();
  });

  it("offers no preview for other types", async () => {
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("plan.txt"));
    await screen.findByRole("button", { name: /Versions/ });
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });
});

describe("binary files", () => {
  beforeEach(mockApi);

  it("previews an image with its text and no editor", async () => {
    vi.spyOn(api, "getDerivedText").mockResolvedValue({
      text: "a cat",
      state: "generated",
    } as Awaited<ReturnType<typeof api.getDerivedText>>);
    vi.spyOn(api, "getMediaDescriber").mockResolvedValue({
      enabled: false,
    } as Awaited<ReturnType<typeof api.getMediaDescriber>>);
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("cat.png"));
    expect((await screen.findByAltText("Preview")).getAttribute("src")).toBe(
      "blob:cat",
    );
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});

describe("making things in the tree", () => {
  beforeEach(mockApi);

  it("makes a file from an inline name, typed by its extension, and opens it", async () => {
    const write = vi.spyOn(api, "writeFile").mockResolvedValue(
      detail({
        ...plan,
        key: "chapter.md",
        mediaType: "text/markdown",
        value: "",
      }),
    );
    show(<FilesExplorer page={session} projectId="p1" />);
    await screen.findByText("plan.txt");
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const box = await screen.findByLabelText("New file name");
    fireEvent.change(box, { target: { value: "chapter.md" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        session,
        "chapter.md",
        "text/markdown",
        "",
      ),
    );
  });

  it("starts a new JSON file as an object, because JSON must parse", async () => {
    const write = vi
      .spyOn(api, "writeFile")
      .mockResolvedValue(detail({ ...plan, key: "c.json" }));
    show(<FilesExplorer page={session} projectId="p1" />);
    await screen.findByText("plan.txt");
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const box = await screen.findByLabelText("New file name");
    fireEvent.change(box, { target: { value: "c.json" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        session,
        "c.json",
        "application/json",
        "{}",
      ),
    );
  });

  it("does not make a file with a name that is not valid, or one that exists", async () => {
    const write = vi.spyOn(api, "writeFile");
    const warn = vi.spyOn(notifications, "show").mockReturnValue("id");
    show(<FilesExplorer page={session} projectId="p1" />);
    await screen.findByText("plan.txt");
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    let box = await screen.findByLabelText("New file name");
    fireEvent.change(box, { target: { value: "bad." } });
    expect(await screen.findByText(/Not a valid name/)).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(write).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByLabelText("New file name")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    box = await screen.findByLabelText("New file name");
    fireEvent.change(box, { target: { value: "plan.txt" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ message: "“plan.txt” already exists." }),
      ),
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("makes a folder in the folder that is selected", async () => {
    const make = vi
      .spyOn(api, "createFolder")
      .mockResolvedValue({ path: "drafts/old", created: true });
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("drafts"));
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const box = await screen.findByLabelText("New folder name");
    fireEvent.change(box, { target: { value: "old" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(make).toHaveBeenCalledWith(session, "drafts/old"),
    );
  });

  it("offers the actions for a folder on right-click, and renames it", async () => {
    const rename = vi
      .spyOn(api, "renameFolder")
      .mockResolvedValue({ path: "scenes" });
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.contextMenu(await screen.findByText("ideas"));
    expect(await screen.findByText("New file here")).toBeTruthy();
    expect(screen.getByText("New folder here")).toBeTruthy();
    expect(screen.getByText("Upload here")).toBeTruthy();
    expect(screen.getByText("Delete folder")).toBeTruthy();
    fireEvent.click(screen.getByText("Rename folder"));
    const box = await screen.findByLabelText("New name for ideas");
    fireEvent.change(box, { target: { value: "scenes" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(rename).toHaveBeenCalledWith(session, "ideas", "scenes"),
    );
  });

  it("asks before deleting a folder, then deletes it", async () => {
    const remove = vi.spyOn(api, "deleteFolder").mockResolvedValue({});
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.contextMenu(await screen.findByText("ideas"));
    fireEvent.click(await screen.findByText("Delete folder"));
    const dialog = await screen.findByRole("dialog");
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(session, "ideas"));
  });

  it("deletes a file from its tab, after asking", async () => {
    const remove = vi.spyOn(api, "deleteFile").mockResolvedValue({});
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("plan.txt"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith(session, "plan.txt"),
    );
  });
});

describe("uploads", () => {
  beforeEach(mockApi);

  const uploaded = (key: string, mediaType: "image/png" | "audio/wav") => ({
    key,
    ref: `session://${key}`,
    mediaType,
    size: 1,
    blob: { hash: "h", size: 1 },
    replaced: false,
  });

  it("uploads the files chosen, to the root and folder selected", async () => {
    const upload = vi
      .spyOn(api, "uploadFile")
      .mockResolvedValue(uploaded("drafts/dog.png", "image/png"));
    show(<FilesExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("drafts"));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    const input = screen.getByLabelText("Choose files to upload");
    const file = new File(["x"], "dog.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(session, file, "image/png", {
        name: "drafts/dog.png",
      }),
    );
  });

  it("refuses a file type that cannot be uploaded, without calling the backend", async () => {
    const upload = vi.spyOn(api, "uploadFile");
    const warn = vi.spyOn(notifications, "show").mockReturnValue("id");
    show(<FilesExplorer page={session} projectId="p1" />);
    await screen.findByText("plan.txt");
    fireEvent.change(screen.getByLabelText("Choose files to upload"), {
      target: { files: [new File(["x"], "a.webp", { type: "image/webp" })] },
    });
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not upload the file" }),
      ),
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads a file dropped on a folder into it", async () => {
    const upload = vi
      .spyOn(api, "uploadFile")
      .mockResolvedValue(uploaded("ideas/voice.wav", "audio/wav"));
    show(<FilesExplorer page={session} projectId="p1" />);
    const folder = await screen.findByText("ideas");
    const file = new File(["x"], "voice.wav", { type: "audio/wav" });
    fireEvent.drop(folder, {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(session, file, "audio/wav", {
        name: "ideas/voice.wav",
      }),
    );
  });

  it("uploads a file dropped on a root to that root", async () => {
    const upload = vi
      .spyOn(api, "uploadFile")
      .mockResolvedValue(uploaded("voice.wav", "audio/wav"));
    show(<FilesExplorer page={session} projectId="p1" />);
    const root = await screen.findByText("Global");
    const file = new File(["x"], "voice.wav", { type: "audio/wav" });
    fireEvent.drop(root, {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(global, file, "audio/wav", {
        name: "voice.wav",
      }),
    );
  });
});

describe("read-only", () => {
  beforeEach(mockApi);

  it("cannot be changed in any root while a run is in progress", async () => {
    const write = vi.spyOn(api, "writeFile");
    show(
      <FilesExplorer
        page={session}
        projectId="p1"
        readOnly="A run is in progress."
      />,
    );
    await screen.findByText("plan.txt");
    for (const name of ["New file", "New folder", "Upload"]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    fireEvent.click(screen.getByText("bible.txt"));
    expect(await screen.findByText("A run is in progress.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByText("ideas"));
    expect(
      await screen.findByText("This folder cannot be changed right now."),
    ).toBeTruthy();
  });

  it("locks only the project root when the project is in the trash", async () => {
    show(
      <FilesExplorer
        page={session}
        projectId="p1"
        projectReadOnly="The project is in the trash."
      />,
    );
    await screen.findByText("plan.txt");
    fireEvent.click(screen.getByText("rules.txt"));
    expect(
      await screen.findByText("The project is in the trash."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByText("plan.txt"));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("the divider", () => {
  beforeEach(mockApi);

  it("resizes the tree with the arrow keys, within limits, and remembers it", async () => {
    const first = show(<FilesExplorer page={global} />);
    const divider = await screen.findByRole("separator");
    expect(divider.getAttribute("aria-valuenow")).toBe("280");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider.getAttribute("aria-valuenow")).toBe("296");
    for (let i = 0; i < 40; i++)
      fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider.getAttribute("aria-valuenow")).toBe("180");
    first.unmount();
    show(<FilesExplorer page={global} />);
    expect(
      (await screen.findByRole("separator")).getAttribute("aria-valuenow"),
    ).toBe("180");
  });
});

describe("a project's color in the Files explorer", () => {
  beforeEach(mockApi);
  const tealProject = (color: Project["color"]) =>
    [{ id: "p1", name: "Novel", color }] as Project[];
  const tab = (name: string) =>
    screen.getByRole("tab", { name: new RegExp(name) });
  const iconBg = (el: HTMLElement) =>
    (
      el.querySelector(".mantine-ThemeIcon-root") as HTMLElement
    ).style.getPropertyValue("--ti-bg");

  it("colors the tabs of the project's files, and no others", async () => {
    const { client } = show(<FilesExplorer page={session} projectId="p1" />);
    client.setQueryData(projectKeys.list(), tealProject("teal"));

    fireEvent.doubleClick(await screen.findByText("plan.txt"));
    await waitFor(() => expect(tab("plan.txt")).toBeTruthy());
    expect(iconBg(tab("plan.txt"))).not.toContain("teal");

    fireEvent.doubleClick(screen.getByText("rules.txt"));
    await waitFor(() => expect(tab("rules.txt")).toBeTruthy());
    expect(iconBg(tab("rules.txt"))).toContain("--mantine-color-teal-filled");
    expect(tab("rules.txt").style.borderTop).toContain(
      "--mantine-color-teal-filled",
    );
    fireEvent.doubleClick(screen.getByText("bible.txt"));
    await waitFor(() => expect(tab("bible.txt")).toBeTruthy());
    expect(iconBg(tab("bible.txt"))).not.toContain("teal");
  });

  it("colors the project's name in the path above its file", async () => {
    const { client } = show(<FilesExplorer page={session} projectId="p1" />);
    client.setQueryData(projectKeys.list(), tealProject("teal"));
    fireEvent.click(await screen.findByText("rules.txt"));
    await screen.findByRole("tab");

    await waitFor(() => {
      const root = screen
        .getAllByText("Project")
        .find((el) => el.parentElement?.textContent?.includes("›"));
      expect(root?.getAttribute("style") ?? "").toContain("teal");
    });
  });

  it("leaves a project without a color as it was", async () => {
    const { client } = show(<FilesExplorer page={session} projectId="p1" />);
    client.setQueryData(projectKeys.list(), tealProject(null));
    fireEvent.doubleClick(await screen.findByText("rules.txt"));
    await waitFor(() => expect(tab("rules.txt")).toBeTruthy());
    expect(iconBg(tab("rules.txt"))).not.toContain("--mantine-color-null");
    expect(tab("rules.txt").style.borderTop).toContain(
      "--mantine-primary-color-filled",
    );
  });
});

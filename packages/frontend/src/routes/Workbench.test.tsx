import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
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
  ApiError,
  type Project,
  type SessionDetail,
  type SessionListItem,
} from "../api";
import { useChatStatus } from "../chatStatus";
import { useDirtyTabs, useReportDirty } from "../dirty";
import { useWorkbench } from "../workbenchStore";
import { Workbench } from "./Workbench";

/*
 * The workbench with its pages stubbed: how an address opens a tab, which
 * tabs stay mounted, what closing a tab with unsaved edits does, where New
 * chat goes, and the small-screen menu. The pages have their own tests.
 */

vi.mock("./Chat", () => ({
  Chat: ({ sessionId }: { sessionId: string }) => (
    <div>chat page {sessionId}</div>
  ),
}));
vi.mock("./ProjectPage", () => ({
  ProjectPage: ({ projectId }: { projectId: string }) => (
    <div>project page {projectId}</div>
  ),
}));
vi.mock("./Sessions", () => ({
  SessionsPage: ({ projectId }: { projectId: string | null }) => (
    <div>sessions page {projectId ?? "none"}</div>
  ),
}));
vi.mock("./Agents", () => ({
  GlobalAgentsPage: () => <div>agents page</div>,
  ProjectAgentsPage: () => null,
}));
vi.mock("./Skills", () => ({
  GlobalSkillsPage: () => <div>skills page</div>,
  ProjectSkillsPage: () => null,
}));
vi.mock("./StructuredDataPages", () => ({
  GlobalStructuredDataPage: () => null,
  ProjectStructuredDataPage: () => null,
}));
vi.mock("./Workspaces", () => ({ WorkspacesPage: () => null }));
vi.mock("./Errors", () => ({ ErrorsPage: () => <div>errors page</div> }));
vi.mock("./Settings", () => ({ Settings: () => <div>settings page</div> }));
// The Files page reports unsaved edits when its button is pressed.
vi.mock("./EntriesPages", () => ({
  ProjectEntriesPage: () => null,
  GlobalEntriesPage: function Files() {
    return <FilesStub />;
  },
}));
import { useState } from "react";
function FilesStub() {
  const [dirty, setDirty] = useState(false);
  useReportDirty(dirty);
  return (
    <div>
      files page
      <button onClick={() => setDirty(true)}>make unsaved</button>
    </div>
  );
}

const session = (id: string, title: string, project: string | null) =>
  ({
    id,
    title,
    created_at: "2026-01-01",
    model: null,
    reasoning_effort: null,
    trashed_at: null,
    project_id: project,
    trashed_with_project: 0,
    agent_id: null,
    usage: null,
  }) satisfies SessionListItem;

const project = (id: string, name: string, used: string) =>
  ({
    id,
    name,
    description: "",
    created_at: "2026-01-01",
    last_used_at: used,
    trashed_at: null,
    default_agent_id: null,
    system_prompt: "",
  }) as Project;

const SESSIONS = [
  session("s1", "Alpha chat", "p1"),
  session("s2", "Beta chat", "p1"),
  session("s3", "Loose chat", null),
];

function mockApi() {
  vi.spyOn(api, "listProjects").mockResolvedValue([
    project("p1", "Novel", "2026-03-01"),
    project("p2", "Poems", "2026-02-01"),
  ]);
  vi.spyOn(api, "listSessions").mockImplementation(async (projectId) =>
    SESSIONS.filter((s) => s.project_id === projectId),
  );
  vi.spyOn(api, "getSession").mockImplementation(async (id) => {
    const s =
      SESSIONS.find((x) => x.id === id) ??
      (id === "new" ? session("new", "New chat", null) : undefined);
    if (!s) throw new ApiError("not found", 404);
    return { session: s, project: null } as unknown as SessionDetail;
  });
  vi.spyOn(api, "listActiveRuns").mockResolvedValue({ runs: [] });
  return vi
    .spyOn(api, "createSession")
    .mockResolvedValue(session("new", "New chat", null));
}

async function show(path: string) {
  const rootRoute = createRootRoute({ component: Workbench });
  const page = () => null;
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: page,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/$",
      component: page,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    render(
      <MantineProvider>
        <ModalsProvider>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>,
    );
  });
  const go = (to: string) => act(() => router.navigate({ to } as never));
  return { router, go };
}

const tabs = () => screen.queryAllByRole("tab");
const tabNamed = (name: string) =>
  screen.getByRole("tab", { name: new RegExp(name) });
const isItalic = (el: HTMLElement) => el.style.fontStyle === "italic";

beforeEach(() => {
  localStorage.clear();
  useWorkbench.setState({
    tabs: [],
    active: null,
    expanded: {},
    settingsPath: "/settings",
  });
  useDirtyTabs.setState({ dirty: {} });
  useChatStatus.setState({ status: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the workbench: tabs and addresses", () => {
  it("opens the tab of the address, with the chat's title", async () => {
    mockApi();
    await show("/sessions/s1");
    expect(await screen.findByText("chat page s1")).toBeTruthy();
    await waitFor(() => expect(tabNamed("Alpha chat")).toBeTruthy());
    expect(tabNamed("Alpha chat").getAttribute("aria-selected")).toBe("true");
  });

  it("shows the empty state at an address with no tab", async () => {
    mockApi();
    await show("/");
    expect(
      screen.getByText("Open a chat or a project from the list."),
    ).toBeTruthy();
    expect(tabs()).toHaveLength(0);
  });

  it("opens a page from the rail as a kept tab", async () => {
    mockApi();
    await show("/");
    fireEvent.click(screen.getByRole("button", { name: "Errors" }));
    expect(await screen.findByText("errors page")).toBeTruthy();
    expect(isItalic(tabNamed("Errors"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    await screen.findByText("agents page");
    expect(tabs()).toHaveLength(2);
  });

  it("opens a tab in italics from a single click, and replaces it with the next", async () => {
    mockApi();
    await show("/");
    // The Novel project, open to its chats.
    fireEvent.click(await screen.findByText("Novel"));
    await screen.findByText("Alpha chat");
    expect(isItalic(tabNamed("Novel"))).toBe(true);

    const tree = () => within(screen.getByRole("tree"));
    fireEvent.click(tree().getByText("Alpha chat"));
    await screen.findByText("chat page s1");
    // The chat took the place of the project's tab.
    expect(tabs()).toHaveLength(1);
    expect(isItalic(tabNamed("Alpha chat"))).toBe(true);

    // A double click keeps the tab; the next single click then adds one.
    fireEvent.doubleClick(tree().getByText("Beta chat"));
    await screen.findByText("chat page s2");
    expect(isItalic(tabNamed("Beta chat"))).toBe(false);
    expect(tabs()).toHaveLength(2);
    fireEvent.click(tree().getByText("Alpha chat"));
    await screen.findByText("chat page s1");
    expect(tabs()).toHaveLength(2);
    expect(tabNamed("Beta chat")).toBeTruthy();
  });

  it("keeps a tab that is double-clicked on the strip", async () => {
    mockApi();
    await show("/sessions/s1");
    await waitFor(() => tabNamed("Alpha chat"));
    // Opened from the address, so it is kept already.
    expect(isItalic(tabNamed("Alpha chat"))).toBe(false);
  });

  it("mounts only the active tab", async () => {
    mockApi();
    const { go } = await show("/sessions/s1");
    await screen.findByText("chat page s1");
    await go("/sessions/s2");
    await screen.findByText("chat page s2");
    expect(screen.queryByText("chat page s1")).toBeNull();
    // Both tabs are still open.
    await waitFor(() => expect(tabs()).toHaveLength(2));
    fireEvent.click(tabNamed("Alpha chat"));
    await screen.findByText("chat page s1");
    expect(screen.queryByText("chat page s2")).toBeNull();
  });

  it("closes a tab and shows its neighbour", async () => {
    mockApi();
    const { go } = await show("/sessions/s1");
    await screen.findByText("chat page s1");
    await go("/errors");
    await screen.findByText("errors page");
    fireEvent.click(screen.getByRole("button", { name: "Close Errors" }));
    await screen.findByText("chat page s1");
    expect(tabs()).toHaveLength(1);
  });

  it("goes back to the tab that was active last time", async () => {
    mockApi();
    localStorage.setItem(
      "harness.workbench.global.-",
      JSON.stringify({
        tabs: [{ kind: "errors", root: "global", key: "", transient: false }],
        active: "errors|global|",
        expanded: {},
        width: 280,
        showDeleted: false,
      }),
    );
    useWorkbench.setState({
      tabs: [{ kind: "errors", root: "global", key: "", transient: false }],
      active: "errors|global|",
    });
    await show("/");
    expect(await screen.findByText("errors page")).toBeTruthy();
  });

  it("closes the tab of a chat that no longer exists", async () => {
    mockApi();
    useWorkbench.setState({
      tabs: [
        { kind: "chat", root: "session", key: "gone", transient: false },
        { kind: "errors", root: "global", key: "", transient: false },
      ],
      active: "errors|global|",
    });
    await show("/errors");
    await waitFor(() => expect(tabs()).toHaveLength(1));
    expect(tabNamed("Errors")).toBeTruthy();
  });

  it("remembers the Settings section for the next visit", async () => {
    mockApi();
    const { go } = await show("/settings/general/models");
    await screen.findByText("settings page");
    await go("/errors");
    await screen.findByText("errors page");
    fireEvent.click(tabNamed("Settings"));
    await screen.findByText("settings page");
    expect(useWorkbench.getState().settingsPath).toBe(
      "/settings/general/models",
    );
  });
});

describe("the workbench: unsaved changes", () => {
  it("keeps a tab with unsaved edits mounted, hidden", async () => {
    mockApi();
    const { go } = await show("/files");
    await screen.findByText("files page");
    fireEvent.click(screen.getByText("make unsaved"));
    await go("/errors");
    await screen.findByText("errors page");
    const files = screen.getByText("files page").closest("[role=tabpanel]");
    expect(files).not.toBeNull();
    expect((files as HTMLElement).hidden).toBe(true);
    expect(
      within(tabNamed("Files")).getByRole("img", { name: "Unsaved changes" }),
    ).toBeTruthy();
  });

  it("does not keep a tab with no unsaved edits", async () => {
    mockApi();
    const { go } = await show("/files");
    await screen.findByText("files page");
    await go("/errors");
    await screen.findByText("errors page");
    expect(screen.queryByText("files page")).toBeNull();
  });

  it("asks before closing a tab with unsaved edits", async () => {
    mockApi();
    await show("/files");
    await screen.findByText("files page");
    fireEvent.click(screen.getByText("make unsaved"));
    fireEvent.click(screen.getByRole("button", { name: /^Close Files/ }));
    expect(
      await screen.findByText("Your unsaved changes to it will be lost."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep open" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Your unsaved changes to it will be lost."),
      ).toBeNull(),
    );
    expect(tabs()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /^Close Files/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(tabs()).toHaveLength(0));
  });

  it("warns before the page is left only while something is unsaved", async () => {
    mockApi();
    const add = vi.spyOn(window, "addEventListener");
    const warned = () =>
      add.mock.calls.some(([type]) => type === "beforeunload");
    await show("/files");
    await screen.findByText("files page");
    expect(warned()).toBe(false);
    fireEvent.click(screen.getByText("make unsaved"));
    await waitFor(() => expect(warned()).toBe(true));
  });
});

describe("the workbench: New chat", () => {
  it("goes to the project of the row last used in the tree", async () => {
    const create = mockApi();
    await show("/errors");
    fireEvent.click(await screen.findByText("Poems"));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("p2"));
  });

  it("goes to the project of the active tab when no row was used", async () => {
    const create = mockApi();
    await show("/sessions/s1");
    await waitFor(() => tabNamed("Alpha chat"));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("p1"));
  });

  it("makes a standalone chat from a page that belongs to no project", async () => {
    const create = mockApi();
    await show("/errors");
    await screen.findByText("errors page");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(null));
  });

  it("opens the new chat as a kept tab", async () => {
    mockApi();
    await show("/errors");
    await screen.findByText("errors page");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await screen.findByText("chat page new");
    await waitFor(() => expect(tabs()).toHaveLength(2));
  });

  it("goes to the project from its menu", async () => {
    const create = mockApi();
    await show("/errors");
    await screen.findByText("Novel");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Novel" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New chat" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("p1"));
  });
});

describe("the chats tree", () => {
  it("lists projects newest use first, and reads chats only for open ones", async () => {
    mockApi();
    await show("/");
    await waitFor(() =>
      expect(
        screen.getAllByRole("group").map((g) => g.getAttribute("aria-label")),
      ).toEqual(["Novel", "Poems", "No project"]),
    );
    expect(api.listSessions).not.toHaveBeenCalledWith("p1");
    expect(api.listSessions).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Open Novel" }));
    await screen.findByText("Alpha chat");
    expect(api.listSessions).toHaveBeenCalledWith("p1");
    expect(api.listSessions).not.toHaveBeenCalledWith("p2");
  });

  it("remembers which projects are open", async () => {
    mockApi();
    await show("/");
    fireEvent.click(await screen.findByRole("button", { name: "Open Novel" }));
    await screen.findByText("Alpha chat");
    expect(useWorkbench.getState().expanded["project:p1"]).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("harness.workbench.global.-") ?? "{}")
        .expanded,
    ).toMatchObject({ "project:p1": true });
  });

  it("filters by project name and by the chats shown", async () => {
    mockApi();
    await show("/");
    fireEvent.click(await screen.findByRole("button", { name: "Open Novel" }));
    await screen.findByText("Alpha chat");
    fireEvent.change(screen.getByLabelText("Filter chats"), {
      target: { value: "beta" },
    });
    expect(screen.queryByText("Alpha chat")).toBeNull();
    expect(screen.getByText("Beta chat")).toBeTruthy();
    expect(screen.queryByText("Poems")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter chats"), {
      target: { value: "poe" },
    });
    expect(screen.getByText("Poems")).toBeTruthy();
    expect(screen.queryByText("Novel")).toBeNull();
  });

  it("has an All chats row for a project and for No project", async () => {
    mockApi();
    await show("/");
    fireEvent.click(await screen.findByRole("button", { name: "Open Novel" }));
    await screen.findByText("Alpha chat");
    const novel = screen.getByRole("group", { name: "Novel" });
    fireEvent.click(within(novel).getByText("All chats"));
    expect(await screen.findByText("sessions page p1")).toBeTruthy();
    const none = screen.getByRole("group", { name: "No project" });
    fireEvent.click(within(none).getByText("All chats"));
    expect(await screen.findByText("sessions page none")).toBeTruthy();
  });

  it("shows the chat in the status bar with its model and context", async () => {
    mockApi();
    await show("/sessions/s1");
    await screen.findByText("chat page s1");
    act(() =>
      useChatStatus.getState().publish({
        sessionId: "s1",
        model: "qwen",
        contextTokens: 1234,
        connected: true,
      }),
    );
    const bar = screen.getByRole("status");
    expect(within(bar).getByText("qwen")).toBeTruthy();
    expect(within(bar).getByText("1,234 tokens")).toBeTruthy();
    expect(within(bar).getByText(/Alpha chat/)).toBeTruthy();
  });
});

describe("the workbench on a small screen", () => {
  const small = () =>
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));

  it("moves the rail and the list into a menu", async () => {
    mockApi();
    small();
    await show("/errors");
    await screen.findByText("errors page");
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open the menu" }));
    expect(
      await screen.findByRole("navigation", { name: "Pages" }),
    ).toBeTruthy();
    expect(await screen.findByRole("tree", { name: "Chats" })).toBeTruthy();
  });

  it("closes the menu once a page is chosen", async () => {
    mockApi();
    small();
    await show("/errors");
    fireEvent.click(screen.getByRole("button", { name: "Open the menu" }));
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    await screen.findByText("agents page");
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull(),
    );
  });

  it("has the rail and the status bar on a wide screen", async () => {
    mockApi();
    await show("/errors");
    expect(screen.getByRole("navigation", { name: "Pages" })).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the menu" })).toBeNull();
  });
});

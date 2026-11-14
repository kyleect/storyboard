import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  api,
  type Settings as SettingsShape,
  type SettingsView,
} from "../../api";
import { Settings } from "./Settings";

/* The settings page: vertical tabs for the areas, horizontal tabs inside. */

/*
 * A router of one address: /settings/<path>. useParams reads it, and navigate
 * changes it, as the real one does, and is recorded.
 */
type Navigation = {
  to: string;
  params: { _splat: string };
  replace?: boolean;
};
const router = vi.hoisted(() => ({
  path: "general/models",
  calls: [] as Navigation[],
  listeners: new Set<() => void>(),
}));

vi.mock("@tanstack/react-router", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    Link: ({ children, ...rest }: { children?: ReactNode }) => (
      <a href="/" {...rest}>
        {children}
      </a>
    ),
    useNavigate: () => (navigation: Navigation) => {
      router.calls.push(navigation);
      router.path = navigation.params._splat;
      router.listeners.forEach((listener) => listener());
      return Promise.resolve();
    },
    useParams: () => ({
      _splat: useSyncExternalStore(
        (listener) => {
          router.listeners.add(listener);
          return () => router.listeners.delete(listener);
        },
        () => router.path,
      ),
    }),
  };
});

/** Opens the page at an address, as a link to it does. */
const visit = (path: string) => {
  router.path = path;
};

const effective: SettingsShape = {
  llamaServerUrl: "http://localhost:8080",
  model: "",
  reasoningEffort: "",
  port: 3000,
  loopLimit: 20,
  copyLimit: 50,
  skillFileMaxMib: 20,
  skillMaxMib: 100,
  skillMaxFiles: 500,
  trashRetentionDays: 30,
  inlineMediaCap: 4,
  keepMediaInline: false,
  workspaceReadCap: 20000,
  mediaDescriberAgent: "",
  mediaDescriberModel: "",
  embeddingModel: "",
  autoRename: true,
  autoRenameSource: "model",
  titleModel: "",
  titlePrompt: "Write a short title.",
  systemPrompt: "",
  skillsInstruction: "You have skills.",
  schemasInstruction: "You have schemas.",
  toolsInstruction: "You have tools.",
  dataInstruction: "Data is listed.",
  agentsInstruction: "You have agents.",
  workspacesInstruction: "You have workspaces.",
  filesInstruction: "You have files.",
  defaultAgentId: "",
  childReminders: 2,
  childPrompt: "Hand back when done.",
  subagentMessageLabel: "",
  subagentDepth: 1,
  editMode: "branch",
  answerAfterEdit: true,
};

const view: SettingsView = { effective, stored: {}, overriddenByEnv: {} };

let save: MockInstance<typeof api.saveSettings>;

beforeEach(() => {
  router.path = "general/models";
  router.calls = [];
  vi.spyOn(api, "getSettings").mockResolvedValue(view);
  save = vi.spyOn(api, "saveSettings").mockResolvedValue(view);
  vi.spyOn(api, "listModels").mockResolvedValue([]);
  vi.spyOn(api, "listAgents").mockResolvedValue([]);
  vi.spyOn(api, "reasoningLevels").mockResolvedValue({ levels: [] });
  vi.spyOn(api, "listTools").mockResolvedValue([]);
  vi.spyOn(api, "listMcpServers").mockResolvedValue([]);
  vi.spyOn(api, "listProjects").mockResolvedValue([]);
  vi.spyOn(api, "getTrash").mockResolvedValue({
    projects: [],
    sessions: [],
    branches: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderSettings() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <ModalsProvider>
          <Settings />
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("tab", { name: "General" });
}

/** The names of the tabs in the list that contains the given tab. */
function siblingsOf(name: string) {
  const list = screen.getByRole("tab", { name }).closest("[role=tablist]");
  if (!(list instanceof HTMLElement)) throw new Error("No tab list");
  return within(list)
    .getAllByRole("tab")
    .map((t) => t.textContent);
}

const open = (name: string) =>
  fireEvent.click(screen.getByRole("tab", { name }));

describe("Settings tabs", () => {
  it("has a vertical tab for each area", async () => {
    await renderSettings();
    expect(siblingsOf("General")).toEqual([
      "General",
      "Chat",
      "Agents",
      "Tools",
      "Trash",
    ]);
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .closest("[role=tablist]")
        ?.getAttribute("aria-orientation"),
    ).toBe("vertical");
  });

  it("opens on General, with its horizontal tabs", async () => {
    await renderSettings();
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(siblingsOf("Models")).toEqual([
      "Models",
      "Server",
      "Profiles",
      "Look & Feel",
    ]);
    expect(await screen.findByText("Default model")).toBeTruthy();
  });

  it("has the theme colour under Look & Feel, with no Save", async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole("tab", { name: "Look & Feel" }));
    expect(await screen.findByLabelText("Theme color")).toBeTruthy();
    expect(router.calls.at(-1)?.params._splat).toBe("general/look");
  });

  it.each([
    [
      "Chat",
      ["System prompt", "Instructions", "Session titles", "Editing", "Media"],
    ],
    ["Agents", ["Subagents", "Limits"]],
    ["Tools", ["Permissions", "MCP servers"]],
  ])("splits %s into horizontal tabs", async (area, subtabs) => {
    await renderSettings();
    open(area);
    const first = subtabs[0];
    if (!first) throw new Error("No subtabs");
    expect(siblingsOf(first)).toEqual(subtabs);
  });

  it("shows Trash as one page, without horizontal tabs", async () => {
    await renderSettings();
    open("Trash");
    expect(await screen.findByLabelText("Days in the trash")).toBeTruthy();
    expect(await screen.findByText("The trash is empty.")).toBeTruthy();
    // Only the vertical list is on the page apart from the other areas' own.
    expect(screen.queryByRole("tab", { name: "Contents" })).toBeNull();
  });

  it("shows another area's page when its tab is chosen", async () => {
    await renderSettings();
    open("Agents");
    expect(await screen.findByLabelText("Subagent depth")).toBeTruthy();
    // The General page stays mounted, but is hidden.
    expect(
      screen.queryByRole("textbox", { name: "llama-server URL" }),
    ).toBeNull();
  });
});

describe("Settings address", () => {
  const selected = (name: string) =>
    screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";

  it("shows the area and section the address names", async () => {
    visit("agents/limits");
    await renderSettings();
    expect(selected("Agents")).toBe(true);
    expect(selected("Limits")).toBe(true);
    expect(selected("Subagents")).toBe(false);
    expect(await screen.findByLabelText("Loop limit")).toBeTruthy();
    // It is already the address that shows, so nothing replaces it.
    expect(router.calls).toEqual([]);
  });

  it("puts a chosen section in the address", async () => {
    await renderSettings();
    open("Server");
    expect(router.calls.at(-1)).toEqual({
      to: "/settings/$",
      params: { _splat: "general/server" },
      replace: false,
    });
    expect(selected("Server")).toBe(true);
  });

  it("puts a chosen area in the address, at its first section", async () => {
    await renderSettings();
    open("Chat");
    expect(router.calls.at(-1)?.params._splat).toBe("chat/system-prompt");
    open("Trash");
    expect(router.calls.at(-1)?.params._splat).toBe("trash");
    open("Tools");
    expect(router.calls.at(-1)?.params._splat).toBe("tools/permissions");
  });

  it("shows the first section of an area named without one", async () => {
    visit("chat");
    await renderSettings();
    expect(selected("Chat")).toBe(true);
    expect(selected("System prompt")).toBe(true);
    // The address says what shows, so it is replaced, not added to history.
    await waitFor(() =>
      expect(router.calls).toEqual([
        {
          to: "/settings/$",
          params: { _splat: "chat/system-prompt" },
          replace: true,
        },
      ]),
    );
  });

  it.each(["nope", "nope/models", "agents/nope", ""])(
    "replaces the address %j with one that shows a page",
    async (path) => {
      visit(path);
      await renderSettings();
      await waitFor(() => expect(router.calls.length).toBe(1));
      const call = router.calls[0];
      expect(call?.replace).toBe(true);
      // Wrong parts fall back to the first; an area that is right is kept.
      expect(call?.params._splat).toBe(
        path.startsWith("agents") ? "agents/subagents" : "general/models",
      );
    },
  );
});

describe("Settings forms", () => {
  it("saves only the Server settings from the Server tab", async () => {
    await renderSettings();
    open("Server");
    fireEvent.change(await screen.findByLabelText("Backend port"), {
      target: { value: "4000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({
      llamaServerUrl: "http://localhost:8080",
      port: 4000,
    });
  });

  it("saves only the limits from the Limits tab", async () => {
    await renderSettings();
    open("Agents");
    open("Limits");
    fireEvent.change(await screen.findByLabelText("Loop limit"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({
      loopLimit: 5,
      copyLimit: 50,
      workspaceReadCap: 20000,
      skillFileMaxMib: 20,
      skillMaxMib: 100,
      skillMaxFiles: 500,
    });
  });

  it("saves only the media settings from the Media tab", async () => {
    await renderSettings();
    open("Chat");
    open("Media");
    fireEvent.change(
      await screen.findByLabelText("Images and audio kept in view"),
      {
        target: { value: "8" },
      },
    );
    // The describer form has its own Save, so the first is the one above it.
    const saveButton = screen.getAllByRole("button", { name: "Save" })[0];
    if (!saveButton) throw new Error("No Save button");
    fireEvent.click(saveButton);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({
      inlineMediaCap: 8,
      keepMediaInline: false,
    });
  });

  it("saves only the instructions from the Instructions tab", async () => {
    await renderSettings();
    open("Chat");
    open("Instructions");
    fireEvent.change(await screen.findByLabelText("Skills instruction"), {
      target: { value: "Load a skill when it fits." },
    });
    fireEvent.change(screen.getByLabelText("Schemas instruction"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({
      skillsInstruction: "Load a skill when it fits.",
      toolsInstruction: "You have tools.",
      schemasInstruction: "",
      dataInstruction: "Data is listed.",
      agentsInstruction: "You have agents.",
      workspacesInstruction: "You have workspaces.",
      filesInstruction: "You have files.",
    });
  });

  it("saves the editing choices from the Editing tab", async () => {
    await renderSettings();
    open("Chat");
    fireEvent.click(screen.getByRole("tab", { name: "Editing" }));
    fireEvent.click(await screen.findByLabelText("Overwrite in place"));
    fireEvent.click(screen.getByLabelText(/Answer after a branched edit/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({
      editMode: "in_place",
      answerAfterEdit: false,
    });
  });

  it("lists deleted branches in the Trash and restores one", async () => {
    vi.spyOn(api, "getTrash").mockResolvedValue({
      projects: [],
      sessions: [],
      branches: [
        {
          messageId: "m9",
          sessionId: "s1",
          sessionTitle: "Story",
          preview: "The old opening",
          trashedAt: "2026-11-08T00:00:00Z",
          messages: 3,
        },
      ],
    });
    const restore = vi
      .spyOn(api, "restoreBranch")
      .mockResolvedValue({ ok: true });
    await renderSettings();
    open("Trash");
    expect(await screen.findByText(/The old opening/)).toBeTruthy();
    expect(screen.queryByText("The trash is empty.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("m9"));
  });

  it("saves only the retention from the Trash tab", async () => {
    await renderSettings();
    open("Trash");
    fireEvent.change(await screen.findByLabelText("Days in the trash"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({ trashRetentionDays: 7 });
  });

  it("does not save a value that fails its check", async () => {
    await renderSettings();
    open("Server");
    fireEvent.change(await screen.findByLabelText("llama-server URL"), {
      target: { value: "not a url" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Must be an http(s) URL")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps an unsaved edit when the tab is left and come back to", async () => {
    await renderSettings();
    open("Server");
    fireEvent.change(await screen.findByLabelText("llama-server URL"), {
      target: { value: "http://example.test:9000" },
    });
    open("Chat");
    open("General");
    open("Server");
    expect(
      (screen.getByLabelText("llama-server URL") as HTMLInputElement).value,
    ).toBe("http://example.test:9000");
  });

  it("fills a form with new settings, such as after another form saves", async () => {
    save.mockResolvedValue({
      ...view,
      effective: { ...effective, port: 4000 },
    });
    await renderSettings();
    open("Agents");
    open("Limits");
    fireEvent.change(await screen.findByLabelText("Loop limit"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    open("General");
    open("Server");
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Backend port") as HTMLInputElement).value,
      ).toBe("4000"),
    );
  });

  it("disables a setting the environment overrides, with its note", async () => {
    vi.spyOn(api, "getSettings").mockResolvedValue({
      ...view,
      overriddenByEnv: { loopLimit: "HARNESS_LOOP_LIMIT" },
    });
    await renderSettings();
    open("Agents");
    open("Limits");
    const input = await screen.findByLabelText("Loop limit");
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(
      screen.getByText(
        "Overridden by the HARNESS_LOOP_LIMIT environment variable",
      ),
    ).toBeTruthy();
  });
});

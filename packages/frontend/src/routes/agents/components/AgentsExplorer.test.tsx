import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
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
import type { SchemaInfo } from "@harness/core";
import {
  api,
  type AgentDetail,
  type DataItem,
  type ListedAgent,
  type SkillWithFiles,
} from "../../../api";
import { emptyGrant } from "../../../lib/tool-grant";
import { useAgentFocus } from "../../../stores/agentFocus";
import { projectKeys } from "../../../queries";
import { useAppEvents } from "../../../hooks/useAppEvents";
import { AgentsExplorer } from "./AgentsExplorer";

afterEach(() => {
  useAgentFocus.getState().clear();
  vi.restoreAllMocks();
  localStorage.clear();
});
beforeEach(() => localStorage.clear());

const must = <T,>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};

const agent = (
  id: string,
  name: string,
  extra: Partial<ListedAgent> = {},
): ListedAgent => ({
  id,
  name,
  description: `${name} agent`,
  prompt: `You are ${name}.`,
  toolGrant: emptyGrant(),
  toolApproval: {},
  childReminders: null,
  childPrompt: null,
  subagent: false,
  newTools: [],
  projectId: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  deleted: false,
  builtin: false,
  isDefault: false,
  ...extra,
});

const DISPATCHER = agent("b1", "Dispatcher", { builtin: true });
const EDITOR = agent("a1", "Editor");
const SCOUT = agent("a2", "Scout", { projectId: "p1" });

const skill = (
  name: string,
  scope: SkillWithFiles["scope"],
  files = ["SKILL.md"],
): SkillWithFiles =>
  ({
    id: `k-${scope}-${name}`,
    name,
    description: "",
    scope,
    projectId: null,
    agentId: null,
    version: 1,
    createdAt: "",
    updatedAt: "",
    deleted: false,
    files: files.map((path) => ({
      path,
      mediaType: "text/markdown",
      size: 3,
      missing: false,
      hash: null,
    })),
  }) as SkillWithFiles;

const schema = (
  id: string,
  name: string,
  scope: SchemaInfo["scope"],
): SchemaInfo => ({
  id,
  name,
  description: "",
  scope,
  version: 1,
  copiedFrom: null,
  deleted: false,
});

const CLUE = schema("sa", "Clue", "agent");
const SETTING = schema("sg", "Setting", "global");

function detail(a: ListedAgent): AgentDetail {
  return { ...a, versions: [] } as AgentDetail;
}

const settings = (
  defaultAgentId: string,
  overriddenByEnv: Record<string, string> = {},
) =>
  ({ effective: { defaultAgentId }, overriddenByEnv }) as unknown as Awaited<
    ReturnType<typeof api.getSettings>
  >;

function mockApi() {
  vi.spyOn(api, "getSettings").mockResolvedValue(settings("a1"));
  vi.spyOn(api, "getProject").mockResolvedValue({
    id: "p1",
    name: "Novel",
    default_agent_id: "a2",
    trashed_at: null,
  } as unknown as Awaited<ReturnType<typeof api.getProject>>);
  vi.spyOn(api, "listAgents").mockImplementation(async (s) =>
    s.scope === "global" ? [DISPATCHER, EDITOR] : [SCOUT],
  );
  vi.spyOn(api, "getAgent").mockImplementation(async (id) => {
    const a = [DISPATCHER, EDITOR, SCOUT].find((x) => x.id === id);
    if (!a) throw new Error("not found");
    return detail(a);
  });
  vi.spyOn(api, "agentTools").mockResolvedValue([]);
  vi.spyOn(api, "agentToolApprovals").mockResolvedValue([]);
  vi.spyOn(api, "listSkillTree").mockImplementation(async (o) => {
    if (o.scope === "agent")
      return [skill("pov", "agent", ["SKILL.md", "refs/a.md"])];
    if (o.scope === "project") return [skill("tone", "project")];
    return [skill("pov", "global"), skill("outline", "builtin")];
  });
  vi.spyOn(api, "dataSchemas").mockResolvedValue([CLUE, SETTING]);
  vi.spyOn(api, "listSchemas").mockResolvedValue({
    readOnly: null,
    schemas: [CLUE],
  });
  vi.spyOn(api, "listData").mockResolvedValue({
    readOnly: null,
    data: [
      {
        id: "d1",
        name: "Case notes",
        description: "",
        scope: "agent",
        schemaId: "sa",
        schemaVersion: 1,
        latestVersion: 1,
        outOfDate: false,
        schemaInScope: true,
        deleted: false,
      } as DataItem,
    ],
  });
}

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

describe("the tree", () => {
  beforeEach(mockApi);

  it("has Built-in and Global roots with their agents", async () => {
    show(<AgentsExplorer />);
    expect(await screen.findByText("Built-in")).toBeTruthy();
    expect(screen.getByText("Global")).toBeTruthy();
    expect(screen.getByText("Dispatcher")).toBeTruthy();
    expect(screen.getByText("Editor")).toBeTruthy();
    expect(screen.queryByText("Project")).toBeNull();
  });

  it("adds the project's agents as a root on a project's page", async () => {
    show(<AgentsExplorer projectId="p1" />);
    expect(await screen.findByText("Project")).toBeTruthy();
    expect(await screen.findByText("Scout")).toBeTruthy();
    expect(vi.mocked(api.listAgents)).toHaveBeenCalledWith(
      { scope: "project", id: "p1" },
      false,
    );
  });

  it("reads an agent's skills and schemas only when it is opened", async () => {
    show(<AgentsExplorer />);
    fireEvent.click(await screen.findByText("Editor"));
    expect(await screen.findByText("Skills")).toBeTruthy();
    expect(screen.getByText("Schemas")).toBeTruthy();
    expect(vi.mocked(api.listSkillTree)).toHaveBeenCalledWith(
      { scope: "agent", id: "a1" },
      false,
    );
    for (const call of vi.mocked(api.listSkillTree).mock.calls) {
      if (call[0].scope === "agent") expect(call[0].id).toBe("a1");
    }
    expect(vi.mocked(api.listSchemas)).toHaveBeenCalledTimes(1);
  });

  it("shows own skills first, then inherited ones by origin, with a tag for a name that is overridden", async () => {
    show(<AgentsExplorer />);
    fireEvent.click(await screen.findByText("Editor"));
    await screen.findByText("Skills");
    fireEvent.click(screen.getByText("Skills"));
    await waitFor(() => expect(screen.getAllByText("Global")).toHaveLength(2));
    expect(screen.getAllByText("Built-in")).toHaveLength(2);
    fireEvent.click(must(screen.getAllByText("Global").at(-1)));
    fireEvent.click(must(screen.getAllByText("Built-in").at(-1)));
    expect(await screen.findByText("Overridden by Agent")).toBeTruthy();
    expect(screen.getByText("outline")).toBeTruthy();
  });

  it("shows own schemas with their data, and inherited schemas as inherited", async () => {
    show(<AgentsExplorer />);
    fireEvent.click(await screen.findByText("Editor"));
    fireEvent.click(await screen.findByText("Schemas"));
    expect(await screen.findByText("Clue")).toBeTruthy();
    fireEvent.click(screen.getByText("Clue"));
    expect(await screen.findByText("Case notes")).toBeTruthy();
    const groups = screen.getAllByText("Global");
    fireEvent.click(must(groups.at(-1)));
    expect(await screen.findByText("Setting")).toBeTruthy();
    expect(screen.getAllByLabelText("Inherited").length).toBeGreaterThan(0);
  });
});

describe("opening", () => {
  beforeEach(mockApi);

  it("opens an agent as a form with its prompt and settings", async () => {
    show(<AgentsExplorer />);
    fireEvent.click(await screen.findByText("Editor"));
    const prompt = (await screen.findByLabelText(
      /^System prompt/,
    )) as HTMLTextAreaElement;
    expect(prompt.value).toBe("You are Editor.");
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      "Editor",
    );
    expect(screen.getByRole("tab").getAttribute("title")).toContain(
      "Global › Editor",
    );
  });

  it("makes one version of the agent with one Save, and only after an edit", async () => {
    const save = vi.spyOn(api, "saveAgent").mockResolvedValue(detail(EDITOR));
    show(<AgentsExplorer />);
    fireEvent.click(await screen.findByText("Editor"));
    const prompt = await screen.findByLabelText(/^System prompt/);
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(prompt, { target: { value: "You edit." } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: "Edits." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toBe("a1");
    expect(save.mock.calls[0]?.[1]).toMatchObject({
      prompt: "You edit.",
      description: "Edits.",
    });
  });

  it("can be put back as it was", async () => {
    show(<AgentsExplorer />);
    fireEvent.click(await screen.findByText("Editor"));
    const prompt = (await screen.findByLabelText(
      /^System prompt/,
    )) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "x" } });
    fireEvent.click(await screen.findByRole("button", { name: "Revert" }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText(/^System prompt/) as HTMLTextAreaElement).value,
      ).toBe("You are Editor."),
    );
  });

  it("opens a built-in agent read-only, with Copy to global", async () => {
    show(<AgentsExplorer />);
    fireEvent.click(await screen.findByText("Dispatcher"));
    await screen.findByLabelText(/^System prompt/);
    expect(screen.getByText(/Built in\. It cannot be changed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy to global" })).toBeTruthy();
  });

  it("starts a new agent from a built-in one's copy", async () => {
    const create = vi
      .spyOn(api, "createAgent")
      .mockResolvedValue(detail(EDITOR));
    show(<AgentsExplorer />);
    fireEvent.click(await screen.findByText("Dispatcher"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy to global" }),
    );
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Dispatcher (copy)"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0]).toEqual({ scope: "global" });
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      name: "Dispatcher (copy)",
      prompt: "You are Dispatcher.",
    });
  });

  it("makes a new agent from the header's button", async () => {
    const create = vi
      .spyOn(api, "createAgent")
      .mockResolvedValue(detail(EDITOR));
    show(<AgentsExplorer />);
    await screen.findByText("Editor");
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    const name = await screen.findByLabelText(/^Name/);
    const save = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Reviser" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[1]).toMatchObject({ name: "Reviser" });
  });

  it("opens an own skill file for editing and an inherited one read-only", async () => {
    vi.spyOn(api, "getSkill").mockResolvedValue({
      ...skill("pov", "agent"),
      body: "",
      versions: [],
    } as never);
    vi.spyOn(api, "getSkillFile").mockResolvedValue({
      path: "refs/a.md",
      mediaType: "text/markdown",
      size: 3,
      missing: false,
      hash: null,
      value: "abc",
    } as never);
    show(<AgentsExplorer />);
    fireEvent.click(await screen.findByText("Editor"));
    fireEvent.click(await screen.findByText("Skills"));
    fireEvent.click(await screen.findByText("pov"));
    const tree = screen.getByRole("tree", { name: "Agents" });
    fireEvent.click(await within(tree).findByText("refs"));
    fireEvent.click(await within(tree).findByText("a.md"));
    await waitFor(() =>
      expect(screen.getByRole("tab").getAttribute("title")).toContain(
        "pov/refs/a.md",
      ),
    );
    expect(screen.queryByText("Read-only")).toBeNull();
  });

  it("remembers the open tabs for the page", async () => {
    show(<AgentsExplorer />);
    fireEvent.click(await screen.findByText("Editor"));
    await screen.findByLabelText(/^System prompt/);
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem("harness.agents.global") ?? "{}").tabs,
      ).toEqual([
        { kind: "agent", root: "global", key: "a1", transient: true },
      ]),
    );
  });

  it("is read-only, for every agent in the project, when the caller says why", async () => {
    show(
      <AgentsExplorer projectId="p1" readOnly="The project is in the trash." />,
    );
    fireEvent.click(await screen.findByText("Scout"));
    await screen.findByLabelText(/^System prompt/);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("The project is in the trash.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "New agent" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("a request from a chat message's badge", () => {
  beforeEach(() => {
    mockApi();
    vi.spyOn(api, "getAgent").mockImplementation(async (id) => {
      const a = [DISPATCHER, EDITOR, SCOUT].find((x) => x.id === id);
      if (!a) throw new Error("not found");
      return {
        ...a,
        version: 3,
        versions: [1, 2, 3].map((seq) => ({
          seq,
          name: a.name,
          description: "",
          prompt: `Prompt of version ${seq}`,
          toolGrant: emptyGrant(),
          toolApproval: {},
          childReminders: null,
          childPrompt: null,
          subagent: false,
          deleted: false,
          createdAt: "2026-01-01T00:00:00Z",
        })),
      } as AgentDetail;
    });
  });

  it("opens the agent's tab and its Versions list on that version", async () => {
    useAgentFocus
      .getState()
      .ask({ agentId: "a1", version: 2, projectId: null });
    show(<AgentsExplorer />);
    expect(await screen.findByText("Versions of Editor")).toBeTruthy();
    expect(await screen.findByText("Prompt of version 2")).toBeTruthy();
    expect(screen.getByRole("tab").getAttribute("title")).toContain(
      "Global › Editor",
    );
    await waitFor(() => expect(useAgentFocus.getState().request).toBeNull());
  });

  it("opens a project's agent on the project's page", async () => {
    useAgentFocus
      .getState()
      .ask({ agentId: "a2", version: 1, projectId: "p1" });
    show(<AgentsExplorer projectId="p1" />);
    expect(await screen.findByText("Versions of Scout")).toBeTruthy();
    expect(screen.getByRole("tab").getAttribute("title")).toContain(
      "Project › Scout",
    );
  });

  it("shows the project's color over a project agent's tab and behind its icon", async () => {
    useAgentFocus
      .getState()
      .ask({ agentId: "a2", version: 1, projectId: "p1" });
    const { client } = show(<AgentsExplorer projectId="p1" />);
    client.setQueryData(projectKeys.list(), [
      { id: "p1", name: "Novel", color: "teal" },
    ]);
    const tab = await screen.findByRole("tab");
    await waitFor(() =>
      expect(tab.style.getPropertyValue("--tab-color")).toContain(
        "--mantine-color-teal-filled",
      ),
    );
    const icon = tab.querySelector(".mantine-ThemeIcon-root") as HTMLElement;
    expect(icon.style.getPropertyValue("--ti-bg")).toContain(
      "--mantine-color-teal-filled",
    );
  });

  it("is let go when the agent is not there", async () => {
    useAgentFocus
      .getState()
      .ask({ agentId: "gone", version: 1, projectId: null });
    show(<AgentsExplorer />);
    await screen.findByText("Editor");
    await waitFor(() => expect(useAgentFocus.getState().request).toBeNull());
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

/** Stands in for the browser's EventSource; tests push messages to it. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((msg: MessageEvent<string>) => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  push(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }
}

describe("skills.changed", () => {
  const originalEventSource = globalThis.EventSource;
  afterEach(() => {
    globalThis.EventSource = originalEventSource;
    FakeEventSource.last = undefined;
  });

  it("refetches the skills of an agent that is open", async () => {
    mockApi();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    function Listening() {
      useAppEvents();
      return <AgentsExplorer />;
    }
    show(<Listening />);
    fireEvent.click(await screen.findByText("Editor"));
    await screen.findByText("Skills");
    const calls = () =>
      vi
        .mocked(api.listSkillTree)
        .mock.calls.filter(([o]) => o.scope === "agent").length;
    const before = calls();

    act(() => {
      FakeEventSource.last?.push({
        type: "skills.changed",
        data: { skillId: "k1", projectId: null, agentId: "a1" },
      });
    });
    await waitFor(() => expect(calls()).toBeGreaterThan(before));
  });
});

describe("the default agent", () => {
  beforeEach(mockApi);

  const radio = (name: string) =>
    screen.getByRole("radio", { name: `Default agent: ${name}` });

  it("is marked on its row, and no other row is", async () => {
    show(<AgentsExplorer />);
    await screen.findByText("Editor");
    await waitFor(() =>
      expect(radio("Editor").getAttribute("aria-checked")).toBe("true"),
    );
    expect(radio("Dispatcher").getAttribute("aria-checked")).toBe("false");
  });

  it("is changed by clicking another row's icon, without opening the agent", async () => {
    const save = vi
      .spyOn(api, "saveSettings")
      .mockResolvedValue(settings("b1"));
    show(<AgentsExplorer />);
    await screen.findByText("Dispatcher");
    fireEvent.click(radio("Dispatcher"));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ defaultAgentId: "b1" }),
    );
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("is cleared by clicking the icon of the default", async () => {
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue(settings(""));
    show(<AgentsExplorer />);
    await screen.findByText("Editor");
    await waitFor(() =>
      expect(radio("Editor").getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(radio("Editor"));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ defaultAgentId: "" }),
    );
  });

  it("cannot be changed when an environment variable sets it", async () => {
    vi.spyOn(api, "getSettings").mockResolvedValue(
      settings("a1", { defaultAgentId: "HARNESS_DEFAULT_AGENT" }),
    );
    show(<AgentsExplorer />);
    await screen.findByText("Editor");
    await waitFor(() =>
      expect((radio("Dispatcher") as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it("is the project's own on a project's page, for agents of any scope", async () => {
    const update = vi.spyOn(api, "updateProject").mockResolvedValue({
      id: "p1",
      default_agent_id: "a1",
    } as unknown as Awaited<ReturnType<typeof api.updateProject>>);
    show(<AgentsExplorer projectId="p1" />);
    await screen.findByText("Scout");
    await waitFor(() =>
      expect(radio("Scout").getAttribute("aria-checked")).toBe("true"),
    );
    expect(radio("Editor").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(radio("Editor"));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("p1", { defaultAgentId: "a1" }),
    );
  });

  it("is locked on a project in the trash", async () => {
    show(<AgentsExplorer projectId="p1" readOnly="In the trash." />);
    await screen.findByText("Scout");
    expect((radio("Scout") as HTMLButtonElement).disabled).toBe(true);
  });
});

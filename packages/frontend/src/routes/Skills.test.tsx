import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Skill, type SkillDetail } from "../api";
import { useAppEvents } from "../live";
import { SkillsPanel } from "./Skills";

/* The skills panel (skills design, decisions 26, 27). */

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: "k1",
  name: "dialogue-polish",
  displayName: "Dialogue Polish",
  description: "Use when revising dialogue.",
  body: "Read each line aloud.",
  scope: "global",
  projectId: null,
  agentId: null,
  version: 1,
  createdAt: "2026-11-02T10:00:00Z",
  updatedAt: "2026-11-02T10:00:00Z",
  deleted: false,
  ...over,
});

const detail = (over: Partial<Skill> = {}): SkillDetail => ({
  ...skill(over),
  versions: [
    {
      seq: 1,
      name: "dialogue-polish",
      displayName: "Dialogue Polish",
      description: "Use when revising dialogue.",
      body: "Read each line aloud.",
      deleted: false,
      createdAt: "2026-11-02T10:00:00Z",
    },
  ],
});

function renderWith(ui: React.ReactElement, client = new QueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider>
        <ModalsProvider>{ui}</ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SkillsPanel", () => {
  it("lists skills by display name with the name the model uses", async () => {
    vi.spyOn(api, "listSkills").mockResolvedValue([
      skill(),
      skill({ id: "k2", name: "scene-outline", displayName: "Scene Outline" }),
    ]);
    renderWith(<SkillsPanel owner={{ scope: "global" }} />);
    expect(await screen.findByText("Dialogue Polish")).toBeTruthy();
    expect(screen.getByText("dialogue-polish")).toBeTruthy();
    expect(screen.getByText("Scene Outline")).toBeTruthy();
    expect(screen.getByText("scene-outline")).toBeTruthy();
    expect(screen.getByText("Pick a skill on the left.")).toBeTruthy();
  });

  it("shows a skill's description, body and name when it is picked", async () => {
    vi.spyOn(api, "listSkills").mockResolvedValue([skill()]);
    vi.spyOn(api, "getSkill").mockResolvedValue(detail());
    renderWith(<SkillsPanel owner={{ scope: "global" }} />);
    fireEvent.click(await screen.findByText("Dialogue Polish"));
    expect(await screen.findByText("Read each line aloud.")).toBeTruthy();
    expect(screen.getByText("Use when revising dialogue.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Versions (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("creates a skill, needing a name and a description", async () => {
    vi.spyOn(api, "listSkills").mockResolvedValue([]);
    const create = vi
      .spyOn(api, "createSkill")
      .mockResolvedValue(detail({ id: "new" }));
    vi.spyOn(api, "getSkill").mockResolvedValue(detail({ id: "new" }));
    renderWith(<SkillsPanel owner={{ scope: "project", id: "p1" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));

    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My Skill" },
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Use when testing." },
    });
    fireEvent.change(screen.getByLabelText("Body"), {
      target: { value: "Do the thing." },
    });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      { scope: "project", id: "p1" },
      {
        displayName: "My Skill",
        description: "Use when testing.",
        body: "Do the thing.",
      },
    );
  });

  it("can be read but not changed when it is read-only", async () => {
    vi.spyOn(api, "listSkills").mockResolvedValue([skill()]);
    vi.spyOn(api, "getSkill").mockResolvedValue(detail());
    renderWith(
      <SkillsPanel
        owner={{ scope: "project", id: "p1" }}
        readOnly="The project is in the trash, so these can be read but not changed."
      />,
    );
    expect(await screen.findByText(/The project is in the trash/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New skill" })).toBeNull();
    fireEvent.click(await screen.findByText("Dialogue Polish"));
    await screen.findByText("Read each line aloud.");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Versions (1)" })).toBeTruthy();
  });

  it("shows deleted skills only when asked", async () => {
    const list = vi
      .spyOn(api, "listSkills")
      .mockImplementation((_o, deleted) =>
        Promise.resolve(
          deleted ? [skill({ deleted: true, displayName: "Gone" })] : [],
        ),
      );
    renderWith(<SkillsPanel owner={{ scope: "global" }} />);
    await screen.findByText("No skills.");
    fireEvent.click(screen.getByLabelText("Show deleted"));
    expect(await screen.findByText("Gone")).toBeTruthy();
    expect(screen.getByText("deleted")).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ scope: "global" }, true);
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

  it("refetches the skills lists", async () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const list = vi.spyOn(api, "listSkills").mockResolvedValue([]);
    function Listening() {
      useAppEvents();
      return <SkillsPanel owner={{ scope: "global" }} />;
    }
    renderWith(<Listening />);
    await screen.findByText("No skills.");
    const before = list.mock.calls.length;

    list.mockResolvedValue([skill({ displayName: "Added Elsewhere" })]);
    act(() => {
      FakeEventSource.last?.push({
        type: "skills.changed",
        data: { skillId: "k1", projectId: null, agentId: null },
      });
    });
    expect(await screen.findByText("Added Elsewhere")).toBeTruthy();
    expect(list.mock.calls.length).toBeGreaterThan(before);
  });
});

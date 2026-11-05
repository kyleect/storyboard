import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredEvent } from "@harness/core";
import { api, type SessionDebug } from "../api";
import { copyText, filterEvents, NO_FILTER } from "../debug";
import { CopyDebugButton, DebugPanel } from "./DebugPanel";

/* The session debugging tools: the copy button and the Debug tab. */

const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;

const events: StoredEvent[] = [
  {
    id: 1,
    runId: "run-aaaa1111",
    sessionId: "s",
    time: at(1),
    type: "run.started",
    data: { kind: "loop", model: "m1" },
  },
  {
    id: 2,
    runId: "run-aaaa1111",
    sessionId: "s",
    time: at(2),
    type: "text.delta",
    data: { messageId: "m", contentIndex: 0, text: "Hel" },
  },
  {
    id: 3,
    runId: "run-aaaa1111",
    sessionId: "s",
    time: at(3),
    type: "tool.called",
    data: {
      messageId: "m",
      contentIndex: 1,
      callId: "c1",
      name: "echo",
      arguments: { text: "needle" },
    },
  },
  {
    id: 4,
    runId: "run-bbbb2222",
    sessionId: "s",
    time: at(4),
    type: "run.finished",
    data: { reason: "stop" },
  },
];

const debug: SessionDebug = {
  format: 1,
  exportedAt: at(5),
  session: { id: "s", title: "T" } as SessionDebug["session"],
  project: null,
  runs: [
    {
      id: "run-aaaa1111",
      parentRunId: null,
      parentCallId: null,
      kind: "loop",
      status: "finished",
      startedAt: at(1),
      endedAt: at(4),
      model: "m1",
      reasoningEffort: null,
      agent: null,
      usage: null,
      error: null,
      systemPrompt: "You are a story helper.",
      tools: [{ name: "echo", description: "Echoes.", inputSchema: {} }],
      request: "recorded",
    },
    {
      id: "run-bbbb2222",
      parentRunId: null,
      parentCallId: null,
      kind: "loop",
      status: "finished",
      startedAt: at(4),
      endedAt: at(4),
      model: null,
      reasoningEffort: null,
      agent: null,
      usage: null,
      error: null,
      systemPrompt: null,
      tools: null,
      request: "not_recorded",
    },
  ],
  messages: [
    {
      id: "u1",
      message: { role: "user", content: "Say hi to the reader" },
      model: null,
      reasoningEffort: null,
      agent: null,
      usage: null,
      runId: null,
      parentCallId: null,
      createdAt: at(0),
    },
  ],
  events,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </MantineProvider>,
  );
}

describe("filterEvents", () => {
  it("hides streaming deltas by default", () => {
    expect(filterEvents(events, NO_FILTER).map((e) => e.id)).toEqual([1, 3, 4]);
    expect(
      filterEvents(events, { ...NO_FILTER, hideStreaming: false }).map(
        (e) => e.id,
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it("filters by type, run and text together", () => {
    const all = { ...NO_FILTER, hideStreaming: false };
    expect(
      filterEvents(events, { ...all, types: ["run.started", "run.finished"] }),
    ).toHaveLength(2);
    expect(
      filterEvents(events, { ...all, runId: "run-bbbb2222" }).map((e) => e.id),
    ).toEqual([4]);
    // The text matches inside the data, not only the type.
    expect(
      filterEvents(events, { ...all, text: "NEEDLE" }).map((e) => e.id),
    ).toEqual([3]);
    expect(
      filterEvents(events, { ...all, text: "needle", runId: "run-bbbb2222" }),
    ).toEqual([]);
  });
});

describe("copyText", () => {
  it("writes a promised text inside the gesture with ClipboardItem", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly items: Record<string, Promise<Blob>>) {}
      },
    );
    vi.stubGlobal("navigator", { clipboard: { write } });
    await copyText(Promise.resolve("hello"));
    expect(write).toHaveBeenCalledTimes(1);
    const [[[item]]] = write.mock.calls as [
      [[{ items: Record<string, Promise<Blob>> }]],
    ];
    const blob = await item.items["text/plain"];
    expect(await blob?.text()).toBe("hello");
  });

  it("falls back to writeText, and throws what the text's promise throws", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyText("plain");
    expect(writeText).toHaveBeenCalledWith("plain");
    await expect(
      copyText(Promise.reject(new Error("no export"))),
    ).rejects.toThrow("no export");
  });
});

describe("CopyDebugButton", () => {
  it("copies the linear view as text", async () => {
    const getDebug = vi.spyOn(api, "getSessionDebug").mockResolvedValue(debug);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderWith(<CopyDebugButton sessionId="s" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy debug" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(getDebug).toHaveBeenCalledWith("s");
    const [[text]] = writeText.mock.calls as [[string]];
    expect(text).toMatch(/^# Session debug export/);
    // The user's message, then the system prompt the run was given.
    expect(text.indexOf("Say hi to the reader")).toBeGreaterThan(0);
    expect(text.indexOf("You are a story helper.")).toBeGreaterThan(
      text.indexOf("Say hi to the reader"),
    );
    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(screen.getByText(/Session text copied/)).toBeTruthy();
  });

  it("copies the whole export as JSON from the menu", async () => {
    vi.spyOn(api, "getSessionDebug").mockResolvedValue(debug);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderWith(<CopyDebugButton sessionId="s" />);

    fireEvent.click(screen.getByRole("button", { name: "More ways to copy" }));
    fireEvent.click(await screen.findByText("Copy as JSON"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const [[text]] = writeText.mock.calls as [[string]];
    const copied = JSON.parse(text) as SessionDebug;
    expect(copied.runs[0]?.systemPrompt).toBe("You are a story helper.");
    expect(copied.events).toHaveLength(4);
    expect(await screen.findByText(/Session JSON copied/)).toBeTruthy();
  });

  it("says so when the export cannot be fetched", async () => {
    vi.spyOn(api, "getSessionDebug").mockRejectedValue(new Error("offline"));
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    renderWith(<CopyDebugButton sessionId="s" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy debug" }));

    expect(await screen.findByText("Could not copy the session")).toBeTruthy();
    expect(await screen.findByText("offline")).toBeTruthy();
  });
});

describe("DebugPanel", () => {
  it("opens on the linear view, oldest first, with the system prompt", async () => {
    vi.spyOn(api, "getSessionDebug").mockResolvedValue(debug);
    renderWith(<DebugPanel sessionId="s" />);

    expect(await screen.findByText(/items, oldest first/)).toBeTruthy();
    // The user's message comes before the run that answers it.
    const user = screen.getByText("Say hi to the reader");
    const system = screen.getByText("You are a story helper.");
    expect(
      user.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "story helper" },
    });
    expect(await screen.findByText(/Showing 1 of /)).toBeTruthy();
    expect(screen.queryByText("Say hi to the reader")).toBeNull();
  });

  it("shows the events, filterable, with each one's data on click", async () => {
    vi.spyOn(api, "getSessionDebug").mockResolvedValue(debug);
    renderWith(<DebugPanel sessionId="s" />);
    fireEvent.click(await screen.findByText(/^Events \(/));

    // Deltas are hidden to begin with.
    expect(
      await screen.findByText(/Showing 3 of 3 matching events/),
    ).toBeTruthy();
    // Not in the table (the Type filter still lists it as a choice).
    expect(
      within(screen.getByRole("table")).queryByText("text.delta"),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "needle" },
    });
    expect(
      await screen.findByText(/Showing 1 of 1 matching events/),
    ).toBeTruthy();

    const row = within(screen.getByRole("table"))
      .getByText("tool.called")
      .closest("tr");
    if (!row) throw new Error("no row for tool.called");
    expect(within(row).getByText(/echo/)).toBeTruthy();
    fireEvent.click(row);
    expect(await screen.findByText(/"callId": "c1"/)).toBeTruthy();
  });

  it("shows each run's system prompt, and what was not recorded", async () => {
    vi.spyOn(api, "getSessionDebug").mockResolvedValue(debug);
    renderWith(<DebugPanel sessionId="s" />);

    fireEvent.click(await screen.findByText("Requests (2)"));

    expect(await screen.findByText("You are a story helper.")).toBeTruthy();
    expect(
      screen.getByText(/Not recorded: this run was made before/),
    ).toBeTruthy();
  });
});

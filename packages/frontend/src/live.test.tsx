import { MantineProvider } from "@mantine/core";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "./api";
import { projectKeys, runKeys, sessionKeys } from "./queries";
import { useAppEvents, useLive, useSessionEvents } from "./live";
import { EditableTitle } from "./routes/EditableTitle";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));

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
  push(id: number, event: unknown) {
    this.onmessage?.({
      lastEventId: String(id),
      data: JSON.stringify(event),
    } as MessageEvent<string>);
  }
}

const original = globalThis.EventSource;
afterEach(() => {
  globalThis.EventSource = original;
  FakeEventSource.last = undefined;
});

const detail: SessionDetail = {
  session: {
    id: "s1",
    title: "New session",
    created_at: "2026-11-01T00:00:00Z",
    model: null,
    reasoning_effort: null,
    trashed_at: null,
    project_id: null,
    trashed_with_project: 0,
    agent_id: null,
  },
  project: null,
  messages: [],
  branching: { points: [], editable: [], regenerate: null, continuations: [] },
  forkedFrom: null,
  subagentUsage: null,
  lastEventId: 0,
  activeRun: null,
  childRuns: [],
} as SessionDetail;

/** The chat header's title, kept live by the session's event stream. */
function Header() {
  const query = useQuery({
    queryKey: sessionKeys.detail("s1"),
    queryFn: () => Promise.resolve(detail),
  });
  useSessionEvents("s1", query.data);
  if (!query.data) return null;
  return (
    <EditableTitle
      title={query.data.session.title}
      label="Session title"
      disabled={false}
      onSave={() => Promise.resolve()}
    />
  );
}

describe("session.renamed", () => {
  it("updates the chat header title", async () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const queryClient = new QueryClient();
    render(
      <MantineProvider>
        <QueryClientProvider client={queryClient}>
          <Header />
        </QueryClientProvider>
      </MantineProvider>,
    );
    expect(await screen.findByText("New session")).toBeTruthy();
    expect(FakeEventSource.last).toBeDefined();

    act(() =>
      FakeEventSource.last?.push(1, {
        runId: null,
        sessionId: "s1",
        time: "2026-11-01T00:00:01Z",
        type: "session.renamed",
        data: {
          title: "The Keeper's Letter",
          source: "model",
          model: null,
          usage: null,
        },
      }),
    );
    expect(await screen.findByText("The Keeper's Letter")).toBeTruthy();
    expect(screen.queryByText("New session")).toBeNull();
  });
});

describe("session.agent_changed", () => {
  it("refetches the session so the agent picker shows the new pick", async () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    let agentId: string | null = null;
    function AgentLabel() {
      const query = useQuery({
        queryKey: sessionKeys.detail("s1"),
        queryFn: () =>
          Promise.resolve({
            ...detail,
            session: { ...detail.session, agent_id: agentId },
          } as SessionDetail),
      });
      useSessionEvents("s1", query.data);
      return (
        <div>
          {query.data ? `agent: ${query.data.session.agent_id ?? "none"}` : ""}
        </div>
      );
    }
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <AgentLabel />
        </QueryClientProvider>
      </MantineProvider>,
    );
    expect(await screen.findByText("agent: none")).toBeTruthy();

    // A tool changed the pick; the session now says so.
    agentId = "a1";
    act(() =>
      FakeEventSource.last?.push(1, {
        runId: null,
        sessionId: "s1",
        time: "2026-11-02T00:00:01Z",
        type: "session.agent_changed",
        data: { agentId: "a1" },
      }),
    );
    expect(await screen.findByText("agent: a1")).toBeTruthy();
  });
});

describe("projects.changed", () => {
  it("refreshes the project list", async () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    function Events() {
      useAppEvents();
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Events />
      </QueryClientProvider>,
    );
    expect(FakeEventSource.last).toBeDefined();
    invalidate.mockClear();

    act(() =>
      FakeEventSource.last?.push(1, {
        type: "projects.changed",
        data: { projectId: "p1" },
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectKeys.list() });
  });
});

describe("runs.changed", () => {
  function mountEvents() {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    function Events() {
      useAppEvents();
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Events />
      </QueryClientProvider>,
    );
    invalidate.mockClear();
    return invalidate;
  }

  it("refreshes the active runs", () => {
    const invalidate = mountEvents();
    act(() =>
      FakeEventSource.last?.push(1, {
        type: "runs.changed",
        data: { sessionId: "s1", runId: "r1" },
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.active() });
  });

  it("refreshes them when the stream opens, since events are not replayed", () => {
    const invalidate = mountEvents();
    act(() => FakeEventSource.last?.onopen?.());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.active() });
  });
});

describe("a subagent's run", () => {
  const ev = (type: string, runId: string, data: object) => ({
    runId,
    sessionId: "s1",
    time: "2026-11-05T00:00:01Z",
    type,
    data,
  });

  function Host() {
    const query = useQuery({
      queryKey: sessionKeys.detail("s1"),
      queryFn: () => Promise.resolve(detail),
    });
    useSessionEvents("s1", query.data);
    return <div>{query.data ? "ready" : ""}</div>;
  }

  async function open() {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    useLive.getState().set("s1", undefined);
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <Host />
        </QueryClientProvider>
      </MantineProvider>,
    );
    await screen.findByText("ready");
  }
  const push = (id: number, event: unknown) =>
    act(() => FakeEventSource.last?.push(id, event));

  it("is kept under the parent run, which is not replaced or cleared", async () => {
    await open();
    push(1, ev("run.started", "r1", { kind: "loop" }));
    push(
      2,
      ev("run.started", "r2", {
        kind: "loop",
        parentRunId: "r1",
        parentCallId: "c1",
        agent: { id: "a", name: "Editor", version: 1, projectId: null },
      }),
    );

    const live = useLive.getState().runs["s1"];
    expect(live?.runId).toBe("r1");
    expect(live?.children["r2"]).toMatchObject({
      parentRunId: "r1",
      parentCallId: "c1",
      agent: { name: "Editor" },
    });

    // The child's run ending leaves the parent in place.
    push(3, ev("run.finished", "r2", { reason: "handed_back" }));
    await vi.waitFor(() =>
      expect(useLive.getState().runs["s1"]?.children["r2"]).toBeUndefined(),
    );
    expect(useLive.getState().runs["s1"]?.runId).toBe("r1");
  });

  it("keeps its forms and approvals on its own run", async () => {
    await open();
    push(1, ev("run.started", "r1", { kind: "loop" }));
    push(
      2,
      ev("run.started", "r2", {
        kind: "loop",
        parentRunId: "r1",
        parentCallId: "c1",
      }),
    );
    const request = {
      requestId: "q1",
      callId: "k1",
      form: { title: "T", fields: [] },
    };
    push(3, ev("input.requested", "r2", request));

    let live = useLive.getState().runs["s1"];
    expect(live?.inputs).toEqual([]);
    expect(live?.children["r2"]?.inputs).toEqual([request]);

    push(4, ev("input.resolved", "r2", { requestId: "q1" }));
    live = useLive.getState().runs["s1"];
    expect(live?.children["r2"]?.inputs).toEqual([]);
  });

  it("starts from the snapshot's child runs", async () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    useLive.getState().set("s1", undefined);
    const base = {
      model: null,
      reasoningEffort: null,
      agent: null,
      message: null,
      approvals: [],
      inputs: [],
      userMessages: ["wait"],
    };
    const withRuns = {
      ...detail,
      activeRun: { runId: "r1", ...base },
      childRuns: [
        { runId: "r2", parentRunId: "r1", parentCallId: "c1", ...base },
      ],
    } as SessionDetail;
    function Snapshot() {
      const query = useQuery({
        queryKey: sessionKeys.detail("s1"),
        queryFn: () => Promise.resolve(withRuns),
      });
      useSessionEvents("s1", query.data);
      return <div>{query.data ? "ready" : ""}</div>;
    }
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <Snapshot />
        </QueryClientProvider>
      </MantineProvider>,
    );
    await screen.findByText("ready");
    expect(Object.keys(useLive.getState().runs["s1"]?.children ?? {})).toEqual([
      "r2",
    ]);
    // The messages the child had not read yet come back with the snapshot.
    expect(useLive.getState().runs["s1"]?.children["r2"]?.userMessages).toEqual(
      ["wait"],
    );
  });

  it("takes the oldest waiting message off when the child reads one", async () => {
    await open();
    push(1, ev("run.started", "r1", { kind: "loop" }));
    push(
      2,
      ev("run.started", "r2", {
        kind: "loop",
        parentRunId: "r1",
        parentCallId: "c1",
      }),
    );
    act(() =>
      useLive.getState().update("s1", "r2", (run) => ({
        ...run,
        userMessages: ["one", "two"],
      })),
    );
    push(
      3,
      ev("user.message", "r2", {
        messageId: "m9",
        source: "user",
        content: "label\n\none",
      }),
    );
    expect(useLive.getState().runs["s1"]?.children["r2"]?.userMessages).toEqual(
      ["two"],
    );
  });

  it("tells the user when the child ends before it read a message", async () => {
    await open();
    push(1, ev("run.started", "r1", { kind: "loop" }));
    push(
      2,
      ev("run.started", "r2", {
        kind: "loop",
        parentRunId: "r1",
        parentCallId: "c1",
      }),
    );
    act(() =>
      useLive.getState().update("s1", "r2", (run) => ({
        ...run,
        userMessages: ["Use tool_b"],
      })),
    );
    const show = vi.spyOn(notifications, "show").mockReturnValue("n1");
    push(3, ev("run.finished", "r2", { reason: "handed_back" }));
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Message not delivered",
        message: expect.stringContaining("Use tool_b"),
      }),
    );
    show.mockRestore();
  });
});

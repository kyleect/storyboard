import { MantineProvider } from "@mantine/core";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "./api";
import { useSessionEvents } from "./live";
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
  lastEventId: 0,
  activeRun: null,
} as SessionDetail;

/** The chat header's title, kept live by the session's event stream. */
function Header() {
  const query = useQuery({
    queryKey: ["session", "s1"],
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

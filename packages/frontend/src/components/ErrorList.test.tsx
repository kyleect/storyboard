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
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type ErrorEntry } from "../api";
import { useAppEvents } from "../hooks/useAppEvents";
import { SessionErrorsPanel } from "./ErrorList";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    hash,
    children,
    ...rest
  }: {
    to: string;
    params?: { sessionId?: string };
    hash?: string;
    children?: ReactNode;
  }) => (
    <a
      href={`${to.replace("$sessionId", params?.sessionId ?? "")}${
        hash ? `#${hash}` : ""
      }`}
      {...rest}
    >
      {children}
    </a>
  ),
  useNavigate: () => () => {},
  useParams: () => ({}),
}));

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

const originalEventSource = globalThis.EventSource;

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  FakeEventSource.last = undefined;
  vi.restoreAllMocks();
});

const toolError: ErrorEntry = {
  id: "e1",
  sessionId: "s1",
  sessionTitle: "Lighthouse",
  projectId: "p1",
  projectName: "Stories",
  runId: "r1",
  messageId: "m1",
  callId: "c1",
  source: "tool",
  kind: "tool_threw",
  toolName: "read_webpage",
  message:
    "read_webpage failed: Could not read https://x.test/: fetch failed (getaddrinfo ENOTFOUND x.test)",
  details: { url: "https://x.test/", status: 404 },
  stack: "ToolError: …\n    at fetchText",
  arguments: { url: "https://x.test/" },
  createdAt: "2026-11-01T10:00:00Z",
};

function renderWith(node: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <MantineProvider>
      <ModalsProvider>
        <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
}

describe("the session's errors panel", () => {
  it("starts collapsed with a count, and lists the session's errors", async () => {
    const list = vi.spyOn(api, "listErrors").mockResolvedValue([toolError]);
    const shown: string[] = [];

    renderWith(
      <SessionErrorsPanel
        sessionId="s1"
        onShowInTranscript={(id) => shown.push(id)}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Errors/ });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(within(toggle).getByText("1")).toBeTruthy());
    expect(list).toHaveBeenCalledWith({ sessionId: "s1" });

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("Stories / Lighthouse")).toBeNull();
    // Shown in a Collapse, which jsdom does not animate open.
    fireEvent.click(screen.getByText("Show in transcript"));
    expect(shown).toEqual(["m1"]);
  });

  it("clears the session's errors after confirming", async () => {
    vi.spyOn(api, "listErrors").mockResolvedValue([toolError]);
    const clear = vi
      .spyOn(api, "clearErrors")
      .mockResolvedValue({ cleared: 1 });

    renderWith(
      <SessionErrorsPanel sessionId="s1" onShowInTranscript={() => {}} />,
    );
    const toggle = screen.getByRole("button", { name: /Errors/ });

    await waitFor(() => expect(within(toggle).getByText("1")).toBeTruthy());
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith("s1"));
  });

  it("updates when one of the session's tool calls fails", async () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const list = vi.spyOn(api, "listErrors").mockResolvedValue([]);

    function Panel() {
      useAppEvents();

      return (
        <SessionErrorsPanel sessionId="s1" onShowInTranscript={() => {}} />
      );
    }

    renderWith(<Panel />);
    const toggle = screen.getByRole("button", { name: /Errors/ });

    await waitFor(() => expect(within(toggle).getByText("0")).toBeTruthy());
    list.mockResolvedValue([toolError]);
    act(() =>
      FakeEventSource.last?.push({
        type: "errors.changed",
        data: { sessionId: "s1" },
      }),
    );
    await waitFor(() => expect(within(toggle).getByText("1")).toBeTruthy());
  });
});

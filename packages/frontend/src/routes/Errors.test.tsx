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
import { api, type ErrorEntry, type ErrorFilterOptions } from "../api";
import { useAppEvents } from "../live";
import { ErrorsPage, SessionErrorsPanel } from "./Errors";

/* The errors consoles (error reporting plan, P7, P8). */

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

const runError: ErrorEntry = {
  ...toolError,
  id: "e2",
  sessionId: "s2",
  sessionTitle: "Solo",
  projectId: null,
  projectName: null,
  messageId: null,
  callId: null,
  source: "run",
  kind: "run_failed",
  toolName: null,
  message: "llama-server: connection refused",
  details: null,
  stack: null,
  arguments: null,
};

const filterOptions: ErrorFilterOptions = {
  sessions: [
    { id: "s1", title: "Lighthouse", projectId: "p1" },
    { id: "s2", title: "Solo", projectId: null },
  ],
  projects: [{ id: "p1", name: "Stories" }],
  tools: ["read_webpage"],
  runs: true,
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

/** The global page, with the app-wide stream that keeps it live. */
function Page() {
  useAppEvents();
  return <ErrorsPage />;
}

describe("the errors page", () => {
  it("lists errors with their session, and shows details on request", async () => {
    vi.spyOn(api, "listErrors").mockResolvedValue([runError, toolError]);
    vi.spyOn(api, "errorFilters").mockResolvedValue(filterOptions);
    renderWith(<ErrorsPage />);

    const items = await screen.findAllByTestId("error-item");
    expect(items).toHaveLength(2);
    const tool = within(items[1] as HTMLElement);
    expect(tool.getByText(toolError.message)).toBeTruthy();
    expect(tool.getByText("read_webpage")).toBeTruthy();
    expect(
      tool.getByText("Stories / Lighthouse").closest("a")?.getAttribute("href"),
    ).toBe("/sessions/s1");
    expect(
      tool.getByText("Show in transcript").closest("a")?.getAttribute("href"),
    ).toBe("/sessions/s1#message-m1");

    fireEvent.click(tool.getByText("Show details"));
    const code = tool.getByText(/Details:/);
    expect(code.textContent).toContain('"status": 404');
    expect(code.textContent).toContain("Arguments:");
    expect(code.textContent).toContain("at fetchText");

    // A failed run: no transcript link, nothing more to show.
    const run = within(items[0] as HTMLElement);
    expect(run.getByText("run")).toBeTruthy();
    expect(run.getByText("Solo")).toBeTruthy();
    expect(run.queryByText("Show in transcript")).toBeNull();
    expect(run.queryByText("Show details")).toBeNull();
  });

  it("filters by session, project and tool or source", async () => {
    const list = vi.spyOn(api, "listErrors").mockResolvedValue([]);
    vi.spyOn(api, "errorFilters").mockResolvedValue(filterOptions);
    renderWith(<ErrorsPage />);
    expect(await screen.findByText("No errors.")).toBeTruthy();
    expect(list).toHaveBeenLastCalledWith({});

    const pick = async (label: string, option: string) => {
      const input = screen
        .getAllByLabelText(label)
        .find((el) => el.tagName === "INPUT");
      if (!input) throw new Error(`no ${label} input`);
      fireEvent.click(input);
      // Mantine's dropdown is still in its transition in jsdom.
      fireEvent.click(
        await screen.findByRole("option", { name: option, hidden: true }),
      );
    };
    await pick("Project", "No project");
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({ projectId: "none" }),
    );
    await pick("Tool or source", "Failed runs");
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        projectId: "none",
        source: "run",
      }),
    );
    await pick("Tool or source", "read_webpage");
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        projectId: "none",
        source: "tool",
        tool: "read_webpage",
      }),
    );
    await pick("Session", "Lighthouse");
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        projectId: "none",
        source: "tool",
        tool: "read_webpage",
        sessionId: "s1",
      }),
    );
  });

  it("clears every error after confirming", async () => {
    vi.spyOn(api, "listErrors").mockResolvedValue([toolError]);
    vi.spyOn(api, "errorFilters").mockResolvedValue(filterOptions);
    const clear = vi
      .spyOn(api, "clearErrors")
      .mockResolvedValue({ cleared: 1 });
    renderWith(<ErrorsPage />);
    await screen.findByTestId("error-item");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith());
  });

  it("updates when an error is recorded", async () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const list = vi.spyOn(api, "listErrors").mockResolvedValue([]);
    vi.spyOn(api, "errorFilters").mockResolvedValue(filterOptions);
    renderWith(<Page />);
    expect(await screen.findByText("No errors.")).toBeTruthy();

    list.mockResolvedValue([toolError]);
    act(() =>
      FakeEventSource.last?.push({
        type: "errors.changed",
        data: { sessionId: "s1" },
      }),
    );
    expect(await screen.findByText(toolError.message)).toBeTruthy();
  });
});

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
    // The session is known here, so no session link.
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

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
import { notifications } from "@mantine/notifications";
import { api, type SessionDetail } from "../../api";
import { useDrafts } from "../../stores/drafts";
import { Chat } from "./Chat";
import type { RecordingMode } from "./components/VoiceButtons";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ sessionId: "s1" }),
  useNavigate: () => navigate,
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params: Record<string, string>;
    children?: React.ReactNode;
  }) => (
    <a href={to.replace("$sessionId", params.sessionId ?? "")} {...rest}>
      {children}
    </a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { hash: string } }) => unknown;
  }) => select({ location: { hash: "" } }),
}));

let liveRun: unknown = undefined;

vi.mock("../../stores/live", () => {
  const state = () => ({ runs: { s1: liveRun }, connected: { s1: true } });
  const useLive = Object.assign(
    (select: (s: unknown) => unknown) => select(state()),
    { getState: state },
  );

  return { liveRuns: () => [], useLive };
});
vi.mock("../../hooks/useSessionEvents", () => ({ useSessionEvents: () => {} }));

let voice: {
  onRecorded: (file: File, mode: RecordingMode) => void;
  sendDisabled?: boolean;
} = { onRecorded: () => {} };

vi.mock("./components/VoiceButtons", () => ({
  VoiceButtons: (props: typeof voice) => {
    voice = props;

    return null;
  },
}));

vi.mock("../agents/Agents", () => ({
  AgentBadge: () => null,
  AgentPicker: () => null,
}));
vi.mock("../../components/ContextMeter", () => ({
  ContextMeter: () => null,
  latestUsage: () => undefined,
}));
vi.mock("../../components/ReasoningPicker", () => ({
  ReasoningPicker: () => null,
  effortLabel: () => "",
}));
vi.mock("../../components/ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("../../components/explorer/FileViews", () => ({
  FilesPanel: () => null,
}));
vi.mock("../../components/structured/Data", () => ({
  SchemasAndData: () => null,
}));
vi.mock("../errors/Errors", () => ({
  SessionErrorsPanel: () => null,
  messageAnchor: (id: string) => `message-${id}`,
}));
vi.mock("./components/DebugPanel", () => ({
  CopyDebugButton: () => null,
  DebugPanel: () => null,
}));

const detail = {
  session: {
    id: "s1",
    title: "Test",
    created_at: "2026-11-07T00:00:00Z",
    model: "gemma-4-E4B-it",
    reasoning_effort: null,
    trashed_at: null,
    project_id: null,
    trashed_with_project: 0,
    continued_from_id: null,
    continued_from_title: null,
    continued_carried: null,
    agent_id: null,
  },
  project: null,
  messages: [],
  branching: { points: [], editable: [], regenerate: null, continuations: [] },
  forkedFrom: null,
  continuedFrom: null,
  continuedTo: null,
  subagentUsage: null,
  lastEventId: 0,
  activeRun: null,
  childRuns: [],
} as unknown as SessionDetail;

const uploaded = (kind: "image" | "audio", name: string) => ({
  key: name,
  ref: `session://${name}`,
  mediaType: kind === "image" ? ("image/png" as const) : ("audio/wav" as const),
  size: 1,
  blob: { hash: `hash-${name}`, size: 1 },
  replaced: false,
});

let send: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  liveRun = undefined;
  useDrafts.setState({ drafts: {} });
  vi.spyOn(api, "getSession").mockResolvedValue(detail);
  vi.spyOn(api, "getSettings").mockResolvedValue({
    effective: { model: "" },
  } as Awaited<ReturnType<typeof api.getSettings>>);
  vi.spyOn(api, "listModels").mockResolvedValue([
    { id: "gemma-4-E4B-it", inputModalities: ["text", "image", "audio"] },
  ]);
  vi.spyOn(api, "uploadFile").mockImplementation(async (_s, file) =>
    file.name === "cat.png"
      ? uploaded("image", "cat.png")
      : uploaded("audio", file.name),
  );
  send = vi
    .spyOn(api, "sendMessage")
    .mockResolvedValue({ runId: "r1", sessionId: "s1" });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  navigate.mockClear();
  vi.restoreAllMocks();
});

async function show() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MantineProvider>
        <ModalsProvider>
          <Chat sessionId="s1" />
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );

  return screen.findByPlaceholderText(/Write a message/);
}

const recording = () => new File(["x"], "voice.wav", { type: "audio/wav" });

describe("recording in the composer", () => {
  it("Record & send sends the recording with the text already written", async () => {
    const box = await show();

    fireEvent.change(box, { target: { value: "Summarize this" } });

    await act(async () => voice.onRecorded(recording(), "send"));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(
      "s1",
      "Summarize this",
      expect.objectContaining({ model: "gemma-4-E4B-it" }),
      ["session://voice.wav"],
    );
  });

  it("Record & send sends what was attached before, then the recording", async () => {
    const box = await show();
    const input = screen.getByLabelText("Choose files to attach");

    fireEvent.change(input, {
      target: { files: [new File(["x"], "cat.png", { type: "image/png" })] },
    });
    await screen.findByAltText("cat.png");
    fireEvent.change(box, { target: { value: "" } });

    await act(async () => voice.onRecorded(recording(), "send"));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith("s1", "", expect.anything(), [
      "session://cat.png",
      "session://voice.wav",
    ]);
  });

  it("Record only attaches the recording", async () => {
    await show();
    await act(async () => voice.onRecorded(recording(), "attach"));
    expect(await screen.findByText("voice.wav")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send while a run is in progress, and says why", async () => {
    liveRun = { runId: "r0", approvals: [], inputs: [], userMessages: [] };
    const shown = vi.spyOn(notifications, "show").mockReturnValue("id");

    await show();
    expect(voice.sendDisabled).toBe(true);

    await act(async () => voice.onRecorded(recording(), "send"));

    expect(send).not.toHaveBeenCalled();
    expect(shown).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Recording attached" }),
    );
    expect(await screen.findByText("voice.wav")).toBeTruthy();
  });

  it("does not send when the upload fails", async () => {
    vi.spyOn(api, "uploadFile").mockRejectedValue(new Error("too big"));
    vi.spyOn(notifications, "show").mockReturnValue("id");
    await show();
    await act(async () => voice.onRecorded(recording(), "send"));
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the chat page", () => {
  it("has no header: the tab and the status bar say what the chat is", async () => {
    await show();
    expect(screen.queryByLabelText("Session title")).toBeNull();
    expect(screen.queryByText("Test")).toBeNull();
    expect(screen.queryByText("live")).toBeNull();
    expect(screen.queryByText("offline")).toBeNull();
    expect(screen.getByRole("radio", { name: "Files" })).toBeTruthy();
  });
});

const stored = (id: string, message: unknown) => ({
  id,
  message,
  model: null,
  reasoningEffort: null,
  agent: null,
  usage: null,
  runId: null,
  parentCallId: null,
  parentId: null,
  branches: null,
});

const withMessages = [
  stored("m1", { role: "user", content: "hello" }),
  stored("m2", { role: "assistant", content: [{ type: "text", text: "hi" }] }),
];

describe("a session that continues another", () => {
  const continuedFrom = {
    id: "s0",
    title: "Plot",
    state: "live" as const,
    carried: 2,
  };

  it("shows where it continues from, and a divider at the carried messages", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue({
      ...detail,
      continuedFrom,
      messages: [
        stored("c1", { role: "carried", content: "the notice", files: [] }),
        ...withMessages,
      ],
    } as SessionDetail);
    await show();
    expect(
      await screen.findByText("Continued from “Plot”. 2 messages carried over"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Plot" }).getAttribute("href"),
    ).toBe("/sessions/s0");
  });
});

describe("a session that was continued", () => {
  const continuedTo = { id: "s2", title: "Test (2)", trashed: false };

  it("is read only: a banner with a link replaces the composer", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue({
      ...detail,
      continuedTo,
      messages: withMessages,
    } as SessionDetail);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MantineProvider>
          <ModalsProvider>
            <Chat sessionId="s1" />
          </ModalsProvider>
        </MantineProvider>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText("This session was continued in a new one"),
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Write a message/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue in a new session" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("/sessions/s2");
  });
});

describe("continuing in a new session", () => {
  it("asks first, then rolls the session over and opens the new one", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue({
      ...detail,
      messages: withMessages,
    } as SessionDetail);
    const rollover = vi
      .spyOn(api, "rolloverSession")
      .mockResolvedValue({ ...detail.session, id: "s2" });

    await show();

    fireEvent.click(
      await screen.findByRole("button", { name: "Continue in a new session" }),
    );
    expect(rollover).not.toHaveBeenCalled();
    expect(await screen.findByText(/becomes read only/)).toBeTruthy();

    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Continue in a new session",
      }),
    );
    await waitFor(() => expect(rollover).toHaveBeenCalledWith("s1"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/sessions/$sessionId",
        params: { sessionId: "s2" },
      }),
    );
  });

  it("is not offered for a session with no messages", async () => {
    await show();
    expect(
      (
        await screen.findByRole("button", {
          name: "Continue in a new session",
        })
      ).hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("sending a message to a session whose context is full", () => {
  it("opens the new session the message went to", async () => {
    send.mockResolvedValue({ runId: "r9", sessionId: "s2" });
    const box = await show();

    fireEvent.change(box, { target: { value: "carry on" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/sessions/$sessionId",
        params: { sessionId: "s2" },
      }),
    );
  });

  it("stays in the session when the message went there", async () => {
    const box = await show();

    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
  });
});

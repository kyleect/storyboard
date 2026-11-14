import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifications } from "@mantine/notifications";
import { api, type SessionDetail } from "../../api";
import { useDrafts } from "../../stores/drafts";
import { Chat } from "./Chat";
import type { RecordingMode } from "./components/VoiceButtons";

/*
 * The composer's use of recordings: "Record" attaches one, "Record & send"
 * sends the message as soon as it has uploaded. The page around the composer
 * is stubbed; the microphone itself is covered by VoiceButtons.test.tsx.
 */

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ sessionId: "s1" }),
  useNavigate: () => () => {},
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { hash: string } }) => unknown;
  }) => select({ location: { hash: "" } }),
}));

// What the run in progress is, for the test to set.
let liveRun: unknown = undefined;
vi.mock("../../stores/live", () => ({
  liveRuns: () => [],
  useSessionEvents: () => {},
  useLive: (select: (s: unknown) => unknown) =>
    select({ runs: { s1: liveRun }, connected: { s1: true } }),
}));

// The recorder's props, for the test to call as the recorder would.
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

// Pieces of the page that have nothing to do with the composer.
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
  send = vi.spyOn(api, "sendMessage").mockResolvedValue({ runId: "r1" });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function show() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MantineProvider>
        <Chat sessionId="s1" />
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
    // No text: the audio and the image are the message.
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
    // No title to edit, and none of what the header held.
    expect(screen.queryByLabelText("Session title")).toBeNull();
    expect(screen.queryByText("Test")).toBeNull();
    expect(screen.queryByText("live")).toBeNull();
    expect(screen.queryByText("offline")).toBeNull();
    // The views are still there.
    expect(screen.getByRole("radio", { name: "Files" })).toBeTruthy();
  });
});

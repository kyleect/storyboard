import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceButtons } from "./VoiceButtons";

// Decoding and resampling need a real browser's audio engine; they are the
// one step stubbed here.
vi.mock("../audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audio")>()),
  recordingFile: vi.fn(
    async () => new File(["x"], "voice.wav", { type: "audio/wav" }),
  ),
  pickRecorderType: () => "audio/webm",
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function show(props: Partial<React.ComponentProps<typeof VoiceButtons>> = {}) {
  const onRecorded = vi.fn();
  render(
    <MantineProvider>
      <VoiceButtons onRecorded={onRecorded} {...props} />
    </MantineProvider>,
  );
  return onRecorded;
}

/** A MediaRecorder that records nothing, and a microphone to match. */
function fakeMicrophone() {
  const tracks = [{ stop: vi.fn() }];
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => tracks })),
    },
  });
  class FakeRecorder {
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio"]) });
      this.onstop?.();
    }
  }
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  return { tracks };
}

const button = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

describe("VoiceButtons", () => {
  it("records for attaching, then hands back the file and lets go of the microphone", async () => {
    const { tracks } = fakeMicrophone();
    const onRecorded = show();

    button("Record").click();
    const stop = await screen.findByRole("button", { name: "Stop recording" });
    expect(stop.textContent).toBe("Stop 0:00 / 0:30");
    // Only the Stop button is shown while recording.
    expect(screen.queryByRole("button", { name: "Record & send" })).toBeNull();

    act(() => stop.click());
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    const [file, mode] = onRecorded.mock.calls[0] as [File, string];
    expect(file.name).toBe("voice.wav");
    expect(mode).toBe("attach");
    expect(tracks[0]?.stop).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Record" })).toBeTruthy();
  });

  it("records for sending, and says which button started it", async () => {
    fakeMicrophone();
    const onRecorded = show();

    button("Record & send").click();
    const stop = await screen.findByRole("button", {
      name: "Stop recording and send",
    });
    expect(stop.textContent).toBe("Stop & send 0:00 / 0:30");

    act(() => stop.click());
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(onRecorded.mock.calls[0]?.[1]).toBe("send");
  });

  it("says so when the browser cannot record", () => {
    vi.stubGlobal("navigator", {});
    const shown = vi.spyOn(notifications, "show").mockReturnValue("id");
    const onRecorded = show();
    button("Record & send").click();
    expect(shown).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("cannot record"),
      }),
    );
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("explains a blocked microphone", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException("no", "NotAllowedError");
        }),
      },
    });
    vi.stubGlobal("MediaRecorder", function MediaRecorder() {});
    const shown = vi.spyOn(notifications, "show").mockReturnValue("id");
    show();
    button("Record").click();
    await waitFor(() =>
      expect(shown).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("blocked"),
        }),
      ),
    );
  });

  it("can be disabled, all of it or only sending", () => {
    const { unmount } = render(
      <MantineProvider>
        <VoiceButtons onRecorded={() => {}} disabled />
      </MantineProvider>,
    );
    expect(button("Record").disabled).toBe(true);
    expect(button("Record & send").disabled).toBe(true);
    unmount();

    show({ sendDisabled: true });
    expect(button("Record").disabled).toBe(false);
    expect(button("Record & send").disabled).toBe(true);
  });
});

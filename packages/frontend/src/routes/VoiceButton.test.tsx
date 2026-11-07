import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceButton } from "./VoiceButton";

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

function show(props: Partial<React.ComponentProps<typeof VoiceButton>> = {}) {
  const onRecorded = vi.fn();
  render(
    <MantineProvider>
      <VoiceButton onRecorded={onRecorded} {...props} />
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

describe("VoiceButton", () => {
  it("records, then hands back the file and lets go of the microphone", async () => {
    const { tracks } = fakeMicrophone();
    const onRecorded = show();

    screen.getByRole("button", { name: "Record" }).click();
    const stop = await screen.findByRole("button", { name: "Stop recording" });
    expect(stop.textContent).toBe("Stop 0:00 / 0:30");

    act(() => stop.click());
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect((onRecorded.mock.calls[0]?.[0] as File).name).toBe("voice.wav");
    expect(tracks[0]?.stop).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Record" })).toBeTruthy();
  });

  it("says so when the browser cannot record", () => {
    vi.stubGlobal("navigator", {});
    const shown = vi.spyOn(notifications, "show").mockReturnValue("id");
    const onRecorded = show();
    screen.getByRole("button", { name: "Record" }).click();
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
    screen.getByRole("button", { name: "Record" }).click();
    await waitFor(() =>
      expect(shown).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("blocked"),
        }),
      ),
    );
  });

  it("can be disabled", () => {
    show({ disabled: true });
    expect(
      (screen.getByRole("button", { name: "Record" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

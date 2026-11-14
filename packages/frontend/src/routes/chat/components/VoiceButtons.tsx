import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useState } from "react";
import {
  formatDuration,
  MAX_RECORDING_SECONDS,
  pickRecorderType,
  recordingFile,
} from "../lib/audio";

/*
 * Records from the microphone and hands back a WAV file (see audio.ts for
 * why WAV, 16 kHz and 30 seconds). There are two buttons:
 *
 * - Record: the recording is attached to the message being written.
 * - Record & send: the recording is sent as soon as it is made.
 *
 * Either one starts the recording and turns into a Stop button; it also stops
 * by itself at the length limit. What happens to the file is up to the
 * caller, which is told which button started the recording. Needs a secure
 * page (https or localhost) and the user's permission.
 */

/** What to do with a recording: attach it, or attach it and send. */
export type RecordingMode = "attach" | "send";

type Phase = "idle" | "recording" | "processing";

const warn = (message: string) =>
  notifications.show({ color: "yellow", title: "Recording failed", message });

const release = (stream: MediaStream) => {
  for (const track of stream.getTracks()) track.stop();
};

export function VoiceButtons({
  onRecorded,
  disabled,
  sendDisabled,
  title,
}: {
  /** Called with the finished recording and the button that started it. */
  onRecorded: (file: File, mode: RecordingMode) => void;
  /** Disables both buttons. */
  disabled?: boolean;
  /** Disables Record & send only, for example while a run is in progress. */
  sendDisabled?: boolean;
  /** A tooltip for both buttons, to say why they are disabled. */
  title?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<RecordingMode>("attach");
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  // The latest callback, as the recording ends long after it was started.
  const callback = useRef(onRecorded);
  useEffect(() => {
    callback.current = onRecorded;
  });

  // Leaving the page while recording stops the microphone.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearInterval(timer.current);
      if (recorder.current && recorder.current.state !== "inactive") {
        recorder.current.stop();
      }
    };
  }, []);

  const start = async (startedAs: RecordingMode) => {
    if (phase !== "idle") return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      warn(
        "This browser cannot record here. Recording needs https or localhost.",
      );
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (err) {
      warn(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access is blocked. Allow it for this page in the browser's site settings."
          : `Could not open the microphone: ${(err as Error).message}`,
      );
      return;
    }
    if (!mounted.current) {
      release(stream);
      return;
    }

    const type = pickRecorderType();
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      window.clearInterval(timer.current);
      release(stream);
      recorder.current = null;
      if (!mounted.current) return;
      setPhase("processing");
      recordingFile(new Blob(chunks, { type: rec.mimeType }), new Date())
        .then((file) => callback.current(file, startedAs))
        .catch((err: unknown) => warn((err as Error).message))
        .finally(() => {
          if (mounted.current) setPhase("idle");
        });
    };

    const startedAt = Date.now();
    timer.current = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      setSeconds(Math.floor(elapsed));
      if (elapsed >= MAX_RECORDING_SECONDS && rec.state === "recording") {
        rec.stop();
      }
    }, 250);
    recorder.current = rec;
    rec.start();
    setSeconds(0);
    setMode(startedAs);
    setPhase("recording");
  };

  const stop = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  };

  if (phase === "recording") {
    const sending = mode === "send";
    return (
      <Button
        color="red"
        onClick={stop}
        aria-label={sending ? "Stop recording and send" : "Stop recording"}
      >
        {sending ? "Stop & send" : "Stop"} {formatDuration(seconds)} /{" "}
        {formatDuration(MAX_RECORDING_SECONDS)}
      </Button>
    );
  }
  const processing = phase === "processing";
  return (
    <>
      <Button
        variant="default"
        loading={processing && mode === "attach"}
        disabled={(disabled ?? false) || processing}
        onClick={() => void start("attach")}
        title={title ?? "Record from the microphone and attach it"}
      >
        Record
      </Button>
      <Button
        variant="default"
        loading={processing && mode === "send"}
        disabled={(disabled ?? false) || (sendDisabled ?? false) || processing}
        onClick={() => void start("send")}
        title={title ?? "Record, and send the message when you stop"}
      >
        Record & send
      </Button>
    </>
  );
}

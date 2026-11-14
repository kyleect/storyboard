import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeWav,
  formatDuration,
  pickRecorderType,
  recordingName,
} from "./audio";

afterEach(() => vi.unstubAllGlobals());

describe("encodeWav", () => {
  const ascii = (b: Uint8Array, from: number, to: number) =>
    String.fromCharCode(...b.slice(from, to));

  it("writes a 16-bit mono PCM header", () => {
    const wav = encodeWav(new Float32Array(4), 16000);
    const view = new DataView(wav.buffer);

    expect(wav.length).toBe(44 + 8);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(ascii(wav, 8, 16)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(wav, 36, 40)).toBe("data");
    expect(view.getUint32(40, true)).toBe(8);
  });

  it("converts samples to 16-bit values and clips what is out of range", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, 2, -2]), 16000);
    const view = new DataView(wav.buffer);
    const at = (i: number) => view.getInt16(44 + i * 2, true);

    expect([at(0), at(1), at(2)]).toEqual([0, 32767, -32768]);
    expect(at(3)).toBe(Math.trunc(0.5 * 0x7fff));
    expect([at(4), at(5)]).toEqual([32767, -32768]);
  });

  it("is accepted by the backend's check for a WAV file", () => {
    const wav = encodeWav(new Float32Array(1), 16000);

    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 12)).toBe("WAVE");
  });
});

describe("recordingName", () => {
  it("names a recording by its local date and time", () => {
    expect(recordingName(new Date(2026, 10, 7, 9, 5, 3))).toBe(
      "voice-20261107-090503.wav",
    );
  });
});

describe("formatDuration", () => {
  it("shows minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(7.9)).toBe("0:07");
    expect(formatDuration(30)).toBe("0:30");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(-3)).toBe("0:00");
  });
});

describe("pickRecorderType", () => {
  it("is undefined when the browser cannot record", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(pickRecorderType()).toBeUndefined();
  });

  it("picks the first format the browser can make", () => {
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: (t: string) => t === "audio/mp4" || t === "audio/webm",
    });
    expect(pickRecorderType()).toBe("audio/webm");
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: (t: string) => t === "audio/mp4",
    });
    expect(pickRecorderType()).toBe("audio/mp4");
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(pickRecorderType()).toBeUndefined();
  });
});

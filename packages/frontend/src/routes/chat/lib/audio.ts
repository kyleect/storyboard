export const RECORDING_SAMPLE_RATE = 16000;

export const MAX_RECORDING_SECONDS = 30;

export const MIN_RECORDING_SECONDS = 0.3;

export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };

  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));

    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Uint8Array(buffer);
}

export function pickRecorderType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;

  return [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ].find((type) => MediaRecorder.isTypeSupported(type));
}

export async function toMono16k(blob: Blob): Promise<Float32Array> {
  const context = new AudioContext();

  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * RECORDING_SAMPLE_RATE)),
      RECORDING_SAMPLE_RATE,
    );
    const source = offline.createBufferSource();

    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();

    return (await offline.startRendering()).getChannelData(0);
  } finally {
    await context.close();
  }
}

const two = (n: number) => String(n).padStart(2, "0");

export function recordingName(now: Date): string {
  const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;

  return `voice-${date}-${time}.wav`;
}

export async function recordingFile(blob: Blob, now: Date): Promise<File> {
  const samples = await toMono16k(blob);

  if (samples.length < MIN_RECORDING_SECONDS * RECORDING_SAMPLE_RATE) {
    throw new Error("The recording is too short.");
  }

  const kept = samples.subarray(
    0,
    MAX_RECORDING_SECONDS * RECORDING_SAMPLE_RATE,
  );

  return new File(
    [encodeWav(kept, RECORDING_SAMPLE_RATE)],
    recordingName(now),
    {
      type: "audio/wav",
    },
  );
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));

  return `${Math.floor(s / 60)}:${two(s % 60)}`;
}

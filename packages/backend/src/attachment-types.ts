import type { AttachmentKind } from "@harness/core";

/*
 * What a user can attach, and how a file is checked.
 *
 * llama-server reads images with stb_image (JPEG, PNG, GIF and BMP are the
 * common ones; WebP is not among them) and audio with miniaudio (MP3, WAV
 * and FLAC). The declared media type must name one of these and the file's
 * first bytes must agree with it, so a file that is not what it says is
 * refused here rather than failing inside the model server.
 */

/** The largest file accepted, in bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** The most files one message takes. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

interface Format {
  kind: AttachmentKind;
  /** The media type stored and sent on. */
  mediaType: string;
  /** Other media types browsers and tools use for the same format. */
  aliases: string[];
  matches: (b: Buffer) => boolean;
}

const startsWith = (b: Buffer, bytes: number[], at = 0) =>
  bytes.every((v, i) => b[at + i] === v);

const FORMATS: Format[] = [
  {
    kind: "image",
    mediaType: "image/png",
    aliases: [],
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
  },
  {
    kind: "image",
    mediaType: "image/jpeg",
    aliases: ["image/jpg"],
    matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  {
    kind: "image",
    mediaType: "image/gif",
    aliases: [],
    matches: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]),
  },
  {
    kind: "image",
    mediaType: "image/bmp",
    aliases: ["image/x-ms-bmp"],
    matches: (b) => startsWith(b, [0x42, 0x4d]),
  },
  {
    kind: "audio",
    mediaType: "audio/wav",
    aliases: ["audio/x-wav", "audio/wave", "audio/vnd.wave"],
    // "RIFF", four size bytes, "WAVE".
    matches: (b) =>
      startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(b, [0x57, 0x41, 0x56, 0x45], 8),
  },
  {
    kind: "audio",
    mediaType: "audio/mpeg",
    aliases: ["audio/mp3"],
    // An ID3 tag, or an MPEG frame sync.
    matches: (b) =>
      startsWith(b, [0x49, 0x44, 0x33]) ||
      (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  },
  {
    kind: "audio",
    mediaType: "audio/flac",
    aliases: ["audio/x-flac"],
    matches: (b) => startsWith(b, [0x66, 0x4c, 0x61, 0x43]),
  },
];

/** The media types accepted, as the canonical ones. */
export const ACCEPTED_MEDIA_TYPES = FORMATS.map((f) => f.mediaType);

/**
 * The kind and canonical media type of a file, or undefined when the
 * declared media type is not accepted or the bytes do not match it.
 */
export function detectAttachment(
  declaredType: string,
  bytes: Buffer,
): { kind: AttachmentKind; mediaType: string } | undefined {
  const declared = declaredType.split(";")[0]?.trim().toLowerCase() ?? "";
  const format = FORMATS.find(
    (f) => f.mediaType === declared || f.aliases.includes(declared),
  );
  if (!format || !format.matches(bytes)) return undefined;
  return { kind: format.kind, mediaType: format.mediaType };
}

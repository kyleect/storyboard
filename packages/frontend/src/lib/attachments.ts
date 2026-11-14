import type { MediaKind } from "@harness/core";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
};

const BY_TYPE: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/bmp": "image/bmp",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/flac": "audio/flac",
  "audio/x-flac": "audio/flac",
};

export const ACCEPT = [
  ...new Set(Object.values(BY_TYPE)),
  ...Object.keys(BY_EXTENSION).map((e) => `.${e}`),
].join(",");

export const ACCEPTED_DESCRIPTION =
  "PNG, JPEG, GIF or BMP images, or WAV, MP3 or FLAC audio";

/**
 * The media type to upload a file as: the browser's, when it is one that can
 * be attached, otherwise from the file's extension (browsers often leave the
 * type of a FLAC file empty). Undefined when it cannot be attached.
 */
export function attachmentMediaType(
  name: string,
  type: string,
): string | undefined {
  const declared = BY_TYPE[type.split(";")[0]?.trim().toLowerCase() ?? ""];

  if (declared) return declared;

  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();

  return extension ? BY_EXTENSION[extension] : undefined;
}

export const kindOf = (mediaType: string): MediaKind =>
  mediaType.startsWith("image/") ? "image" : "audio";

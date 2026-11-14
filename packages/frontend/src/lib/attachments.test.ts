import { describe, expect, it } from "vitest";
import { ACCEPT, attachmentMediaType, kindOf } from "./attachments";

describe("attachmentMediaType", () => {
  it("uses the browser's type when it can be attached", () => {
    expect(attachmentMediaType("x", "image/png")).toBe("image/png");
    expect(attachmentMediaType("x", "image/jpg")).toBe("image/jpeg");
    expect(attachmentMediaType("x", "audio/x-wav")).toBe("audio/wav");
    expect(attachmentMediaType("x", "audio/mp3; codecs=x")).toBe("audio/mpeg");
  });

  it("falls back to the extension when the type is empty", () => {
    expect(attachmentMediaType("song.FLAC", "")).toBe("audio/flac");
    expect(attachmentMediaType("photo.jpeg", "application/octet-stream")).toBe(
      "image/jpeg",
    );
  });

  it("refuses what llama-server cannot read", () => {
    expect(attachmentMediaType("a.webp", "image/webp")).toBeUndefined();
    expect(attachmentMediaType("a.m4a", "audio/mp4")).toBeUndefined();
    expect(attachmentMediaType("a.ogg", "audio/ogg")).toBeUndefined();
    expect(attachmentMediaType("noextension", "")).toBeUndefined();
  });
});

describe("kindOf and ACCEPT", () => {
  it("tells images from audio", () => {
    expect(kindOf("image/gif")).toBe("image");
    expect(kindOf("audio/flac")).toBe("audio");
  });

  it("lists types and extensions for the file picker", () => {
    expect(ACCEPT.split(",")).toEqual(
      expect.arrayContaining(["image/png", "audio/mpeg", ".jpg", ".flac"]),
    );
    expect(ACCEPT).not.toContain("webp");
  });
});

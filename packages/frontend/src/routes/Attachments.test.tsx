import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { DraftAttachments, MessageAttachments } from "./Attachments";

afterEach(() => vi.restoreAllMocks());

function show(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider>{ui}</MantineProvider>
    </QueryClientProvider>,
  );
}

describe("MessageAttachments", () => {
  it("shows an image and an audio player from the fetched bytes", async () => {
    const urls: Record<string, string> = { i1: "blob:image", a1: "blob:audio" };
    vi.spyOn(api, "attachmentUrl").mockImplementation(
      async (id) => urls[id] ?? "",
    );
    const { container } = show(
      <MessageAttachments
        attachments={[
          { id: "i1", kind: "image", mediaType: "image/png", name: "cat.png" },
          { id: "a1", kind: "audio", mediaType: "audio/wav", name: "hi.wav" },
        ]}
      />,
    );
    const img = await screen.findByAltText("cat.png");
    expect(img.getAttribute("src")).toBe("blob:image");
    await waitFor(() =>
      expect(container.querySelector("audio")?.getAttribute("src")).toBe(
        "blob:audio",
      ),
    );
    expect(screen.getByText("hi.wav")).toBeTruthy();
  });

  it("says when a file cannot be loaded", async () => {
    vi.spyOn(api, "attachmentUrl").mockRejectedValue(new Error("gone"));
    show(
      <MessageAttachments
        attachments={[
          { id: "i1", kind: "image", mediaType: "image/png", name: "cat.png" },
        ]}
      />,
    );
    expect(await screen.findByText("Could not load cat.png.")).toBeTruthy();
  });
});

describe("DraftAttachments", () => {
  it("lists the chosen files and removes one", () => {
    const removed: string[] = [];
    show(
      <DraftAttachments
        items={[
          {
            attachment: {
              id: "i1",
              kind: "image",
              mediaType: "image/png",
              name: "cat.png",
            },
            previewUrl: "blob:thumb",
          },
          {
            attachment: {
              id: "a1",
              kind: "audio",
              mediaType: "audio/wav",
              name: "hi.wav",
            },
            previewUrl: undefined,
          },
        ]}
        uploading={0}
        onRemove={(id) => removed.push(id)}
      />,
    );
    expect(screen.getByAltText("cat.png").getAttribute("src")).toBe(
      "blob:thumb",
    );
    expect(screen.getByText("audio")).toBeTruthy();
    screen.getByRole("button", { name: "Remove hi.wav" }).click();
    expect(removed).toEqual(["a1"]);
  });

  it("lets a recording be played back before it is sent", () => {
    const { container } = show(
      <DraftAttachments
        items={[
          {
            attachment: {
              id: "a1",
              kind: "audio",
              mediaType: "audio/wav",
              name: "voice.wav",
            },
            previewUrl: "blob:voice",
          },
        ]}
        uploading={0}
        onRemove={() => {}}
      />,
    );
    expect(container.querySelector("audio")?.getAttribute("src")).toBe(
      "blob:voice",
    );
  });

  it("shows nothing when there is nothing to show", () => {
    const { container } = show(
      <DraftAttachments items={[]} uploading={0} onRemove={() => {}} />,
    );
    // (Mantine adds its own style elements to the container.)
    expect(
      container.querySelectorAll("button, img, [aria-label]"),
    ).toHaveLength(0);
  });
});

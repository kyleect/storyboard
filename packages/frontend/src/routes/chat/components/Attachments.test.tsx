import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type StoredFile } from "../../../api";
import type { MediaType } from "@harness/core";
import {
  DraftAttachments,
  MessageFiles,
  SessionFilesContext,
} from "./Attachments";

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

const where = { sessionId: "s1", projectId: "p1" };

function showFiles(files: string[]) {
  return show(
    <SessionFilesContext.Provider value={where}>
      <MessageFiles files={files} />
    </SessionFilesContext.Provider>,
  );
}

const file = (key: string, mediaType: MediaType, hash: string): StoredFile => ({
  key,
  mediaType,
  value: "",
  blob: { hash, size: 1 },
  updatedAt: "t",
  deleted: false,
});

describe("MessageFiles keep choice", () => {
  const setup = (choices: { ref: string; keep: boolean }[]) => {
    vi.spyOn(api, "listFiles").mockResolvedValue([
      file("cat.png", "image/png", "h1"),
    ]);
    vi.spyOn(api, "blobUrl").mockResolvedValue("blob:image");
    // The server keeps what is set, so the next read shows it.
    let saved = choices;
    vi.spyOn(api, "getMediaChoices").mockImplementation(async () => saved);
    return vi
      .spyOn(api, "setMediaChoice")
      .mockImplementation(async (_id, ref, keep) => {
        saved = keep === null ? [] : [{ ref, keep }];
        return { ref, keep };
      });
  };
  const radio = (name: string) =>
    screen.getByRole("radio", { name }) as HTMLInputElement;

  it("shows the saved choice and defaults to the default", async () => {
    setup([{ ref: "session://cat.png", keep: false }]);
    showFiles(["session://cat.png"]);
    await waitFor(() => expect(radio("Drop later").checked).toBe(true));
    expect(radio("Default").checked).toBe(false);
  });

  it("saves keep, drop and a return to the default", async () => {
    const set = setup([]);
    showFiles(["session://cat.png"]);
    await waitFor(() => expect(radio("Default").checked).toBe(true));
    fireEvent.click(radio("Keep in view"));
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith("s1", "session://cat.png", true),
    );
    fireEvent.click(radio("Drop later"));
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith("s1", "session://cat.png", false),
    );
    fireEvent.click(radio("Default"));
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith("s1", "session://cat.png", null),
    );
  });
});

describe("MessageFiles", () => {
  it("shows an image and an audio player from the fetched bytes", async () => {
    const list = vi
      .spyOn(api, "listFiles")
      .mockResolvedValue([
        file("cat.png", "image/png", "h1"),
        file("hi.wav", "audio/wav", "h2"),
      ]);
    const urls: Record<string, string> = { h1: "blob:image", h2: "blob:audio" };
    vi.spyOn(api, "blobUrl").mockImplementation(async (h) => urls[h] ?? "");
    const { container } = showFiles(["session://cat.png", "session://hi.wav"]);
    const img = await screen.findByAltText("cat.png");
    expect(img.getAttribute("src")).toBe("blob:image");
    await waitFor(() =>
      expect(container.querySelector("audio")?.getAttribute("src")).toBe(
        "blob:audio",
      ),
    );
    expect(screen.getByText("hi.wav")).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ scope: "session", id: "s1" }, false);
  });

  it("finds a project or global file in its own scope", async () => {
    const list = vi
      .spyOn(api, "listFiles")
      .mockImplementation(async (s) =>
        s.scope === "project"
          ? [file("p.png", "image/png", "hp")]
          : [file("g.png", "image/png", "hg")],
      );
    vi.spyOn(api, "blobUrl").mockImplementation(async (h) => `blob:${h}`);
    showFiles(["project://p.png", "global://g.png"]);
    expect((await screen.findByAltText("p.png")).getAttribute("src")).toBe(
      "blob:hp",
    );
    expect((await screen.findByAltText("g.png")).getAttribute("src")).toBe(
      "blob:hg",
    );
    expect(list).toHaveBeenCalledWith({ scope: "project", id: "p1" }, false);
    expect(list).toHaveBeenCalledWith({ scope: "global" }, false);
  });

  it("says when a file is no longer there", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue([]);
    showFiles(["session://gone.png", "workspace://w/x.png"]);
    expect(
      await screen.findByText("gone.png is no longer available."),
    ).toBeTruthy();
    expect(screen.getByText("x.png is no longer available.")).toBeTruthy();
  });

  it("says when the bytes cannot be loaded", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue([
      file("cat.png", "image/png", "h1"),
    ]);
    vi.spyOn(api, "blobUrl").mockRejectedValue(new Error("gone"));
    showFiles(["session://cat.png"]);
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
            ref: "session://cat.png",
            name: "cat.png",
            kind: "image",
            mediaType: "image/png",
            previewUrl: "blob:thumb",
          },
          {
            ref: "session://hi.wav",
            name: "hi.wav",
            kind: "audio",
            mediaType: "audio/wav",
            previewUrl: undefined,
          },
        ]}
        uploading={0}
        onRemove={(ref) => removed.push(ref)}
      />,
    );
    expect(screen.getByAltText("cat.png").getAttribute("src")).toBe(
      "blob:thumb",
    );
    expect(screen.getByText("audio")).toBeTruthy();
    screen.getByRole("button", { name: "Remove hi.wav" }).click();
    expect(removed).toEqual(["session://hi.wav"]);
  });

  it("lets a recording be played back before it is sent", () => {
    const { container } = show(
      <DraftAttachments
        items={[
          {
            ref: "session://voice.wav",
            name: "voice.wav",
            kind: "audio",
            mediaType: "audio/wav",
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

import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Entry, type EntryDetail } from "../api";
import { FilesPanel, ValueView } from "./Entries";

afterEach(() => vi.restoreAllMocks());

const scope = { scope: "session", id: "s1" } as const;

const cat: Entry = {
  key: "cat.png",
  mediaType: "image/png",
  value: "",
  blob: { hash: "h-cat", size: 2048 },
  updatedAt: "2026-11-07T00:00:00Z",
  deleted: false,
};
const note: Entry = {
  key: "notes.md",
  mediaType: "text/markdown",
  value: "# Hi",
  updatedAt: "2026-11-07T00:00:00Z",
  deleted: false,
};

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

describe("ValueView of a binary file", () => {
  it("shows an image from its bytes, with its type and size", async () => {
    vi.spyOn(api, "blobUrl").mockResolvedValue("blob:cat");
    show(
      <ValueView
        mediaType="image/png"
        value=""
        blob={{ hash: "h-cat", size: 2048 }}
      />,
    );
    expect((await screen.findByAltText("Preview")).getAttribute("src")).toBe(
      "blob:cat",
    );
    expect(screen.getByText("image/png, 2 KB")).toBeTruthy();
  });

  it("plays audio", async () => {
    vi.spyOn(api, "blobUrl").mockResolvedValue("blob:voice");
    const { container } = show(
      <ValueView
        mediaType="audio/wav"
        value=""
        blob={{ hash: "h-voice", size: 3 * 1024 * 1024 }}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("audio")?.getAttribute("src")).toBe(
        "blob:voice",
      ),
    );
    expect(screen.getByText("audio/wav, 3.0 MB")).toBeTruthy();
  });

  it("says when the bytes cannot be loaded", async () => {
    vi.spyOn(api, "blobUrl").mockRejectedValue(new Error("gone"));
    show(
      <ValueView
        mediaType="image/png"
        value=""
        blob={{ hash: "h-x", size: 1 }}
      />,
    );
    expect(
      await screen.findByText(/Could not load the file: gone/),
    ).toBeTruthy();
  });
});

describe("FilesPanel with binary files", () => {
  beforeEach(() => {
    vi.spyOn(api, "listEntries").mockResolvedValue([cat, note]);
    vi.spyOn(api, "listFolders").mockResolvedValue([]);
    vi.spyOn(api, "getEntry").mockImplementation(async (_s, _k, key) => {
      const e = key === "cat.png" ? cat : note;
      return { ...e, versions: [] } as EntryDetail;
    });
    vi.spyOn(api, "blobUrl").mockResolvedValue("blob:cat");
  });

  it("lists a binary file with its type and previews it without an editor", async () => {
    show(<FilesPanel scope={scope} />);
    fireEvent.click(await screen.findByText("cat.png"));
    expect((await screen.findByAltText("Preview")).getAttribute("src")).toBe(
      "blob:cat",
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();

    // A text file still has its editor.
    fireEvent.click(screen.getByText("notes.md"));
    expect(await screen.findByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("uploads the files chosen, as binary files of the scope", async () => {
    const upload = vi.spyOn(api, "uploadFile").mockResolvedValue({
      key: "dog.png",
      ref: "session://dog.png",
      mediaType: "image/png",
      size: 1,
      blob: { hash: "h-dog", size: 1 },
      replaced: false,
    });
    show(<FilesPanel scope={scope} />);
    const input = await screen.findByLabelText("Choose files to upload");
    const file = new File(["x"], "dog.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(scope, file, "image/png"),
    );
  });

  it("refuses a file type that cannot be uploaded, without calling the backend", async () => {
    const upload = vi.spyOn(api, "uploadFile");
    const warn = vi.spyOn(notifications, "show").mockReturnValue("id");
    show(<FilesPanel scope={scope} />);
    const input = await screen.findByLabelText("Choose files to upload");
    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.webp", { type: "image/webp" })] },
    });
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not upload the file" }),
      ),
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads a file dropped on the panel", async () => {
    const upload = vi.spyOn(api, "uploadFile").mockResolvedValue({
      key: "voice.wav",
      ref: "session://voice.wav",
      mediaType: "audio/wav",
      size: 1,
      blob: { hash: "h-v", size: 1 },
      replaced: false,
    });
    show(<FilesPanel scope={scope} />);
    // Events bubble up to the panel, so any part of it takes the drop.
    const panel = await screen.findByText("Show deleted");
    const file = new File(["x"], "voice.wav", { type: "audio/wav" });
    fireEvent.drop(panel, {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(scope, file, "audio/wav"),
    );
  });

  it("has no upload button when the scope is read-only", async () => {
    show(<FilesPanel scope={scope} readOnly="A run is in progress." />);
    await screen.findByText("cat.png");
    expect(screen.queryByLabelText("Choose files to upload")).toBeNull();
  });
});

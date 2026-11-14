import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type UploadedFile } from "../api";
import { dropDraft, useDraft, useDrafts } from "./drafts";
import { useAttachmentDraft } from "../routes/chat/components/Attachments";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

const png = () => new File(["x"], "cat.png", { type: "image/png" });

let revoked: string[] = [];
let n = 0;

beforeEach(() => {
  useDrafts.setState({ drafts: {} });
  revoked = [];
  n = 0;
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${++n}`,
    revokeObjectURL: (u: string) => revoked.push(u),
  });
  vi.spyOn(api, "uploadFile").mockImplementation(
    async (_scope, file) =>
      ({
        ref: `session://${file.name}`,
        key: file.name,
        mediaType: "image/png",
      }) as UploadedFile,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the attachments being written", () => {
  it("survive the composer going away and coming back", async () => {
    const first = renderHook(() => useAttachmentDraft("s1"), { wrapper });

    await act(() => first.result.current.add([png()]));
    expect(first.result.current.items).toHaveLength(1);
    first.unmount();

    const again = renderHook(() => useAttachmentDraft("s1"), { wrapper });

    expect(again.result.current.items.map((i) => i.ref)).toEqual([
      "session://cat.png",
    ]);
    expect(revoked).toEqual([]);
  });

  it("start empty in another session", async () => {
    const a = renderHook(() => useAttachmentDraft("s1"), { wrapper });

    await act(() => a.result.current.add([png()]));
    const b = renderHook(() => useAttachmentDraft("s2"), { wrapper });

    expect(b.result.current.items).toEqual([]);
  });

  it("release the previews when removed or cleared", async () => {
    const { result } = renderHook(() => useAttachmentDraft("s1"), { wrapper });

    await act(() => result.current.add([png(), png()]));
    act(() => result.current.remove("session://cat.png"));
    expect(revoked).toEqual(["blob:1", "blob:2"]);
    await act(() => result.current.add([png()]));
    act(() => result.current.clear());
    expect(revoked).toContain("blob:3");
    expect(result.current.items).toEqual([]);
  });

  it("keep an upload that finishes after the composer went away", async () => {
    let finish: (v: UploadedFile) => void = () => {};

    vi.spyOn(api, "uploadFile").mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    const first = renderHook(() => useAttachmentDraft("s1"), { wrapper });
    let pending: Promise<unknown> = Promise.resolve();

    act(() => {
      pending = first.result.current.add([png()]);
    });
    expect(first.result.current.uploading).toBe(1);
    first.unmount();
    await act(async () => {
      finish({
        ref: "session://cat.png",
        key: "cat.png",
        mediaType: "image/png",
      } as UploadedFile);
      await pending;
    });
    const again = renderHook(() => useAttachmentDraft("s1"), { wrapper });

    expect(again.result.current.items).toHaveLength(1);
    expect(again.result.current.uploading).toBe(0);
  });
});

describe("the text being written", () => {
  it("is kept per session, and dropped with its previews", async () => {
    const files = renderHook(() => useAttachmentDraft("s1"), { wrapper });

    await act(() => files.result.current.add([png()]));
    act(() =>
      useDrafts.getState().patch("s1", (d) => ({ ...d, text: "Once upon" })),
    );
    const s1 = renderHook(() => useDraft("s1"), { wrapper });
    const s2 = renderHook(() => useDraft("s2"), { wrapper });

    expect(s1.result.current.text).toBe("Once upon");
    expect(s2.result.current.text).toBe("");

    act(() => dropDraft("s1"));
    expect(s1.result.current).toMatchObject({ text: "", items: [] });
    expect(revoked).toEqual(["blob:1"]);
  });
});

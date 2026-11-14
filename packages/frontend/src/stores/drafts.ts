import { create } from "zustand";
import type { MediaKind } from "@harness/core";

export interface DraftAttachment {
  ref: string;
  name: string;
  mediaType: string;
  kind: MediaKind;
  previewUrl: string | undefined;
}

export interface SessionDraft {
  text: string;
  items: DraftAttachment[];
  uploading: number;
}

export const EMPTY_DRAFT: SessionDraft = { text: "", items: [], uploading: 0 };

export function revokePreview(item: DraftAttachment): void {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
}

interface DraftsState {
  drafts: Record<string, SessionDraft>;
  patch: (sessionId: string, change: (d: SessionDraft) => SessionDraft) => void;
  drop: (sessionId: string) => void;
}

export const useDrafts = create<DraftsState>((set, get) => ({
  drafts: {},
  patch: (sessionId, change) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [sessionId]: change(s.drafts[sessionId] ?? EMPTY_DRAFT),
      },
    })),
  drop: (sessionId) => {
    for (const i of get().drafts[sessionId]?.items ?? []) revokePreview(i);
    set((s) => ({
      drafts: Object.fromEntries(
        Object.entries(s.drafts).filter(([id]) => id !== sessionId),
      ),
    }));
  },
}));

export const useDraft = (sessionId: string): SessionDraft =>
  useDrafts((s) => s.drafts[sessionId] ?? EMPTY_DRAFT);

export const dropDraft = (sessionId: string): void =>
  useDrafts.getState().drop(sessionId);

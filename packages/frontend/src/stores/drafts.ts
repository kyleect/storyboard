import { create } from "zustand";
import type { MediaKind } from "@harness/core";

/*
 * The message being written in each session: its text, the files attached to
 * it and the number of uploads in progress. Kept here, not in the composer,
 * so that leaving a chat (its tab is not the active one, so it is not
 * mounted) does not lose what was typed. Not saved across reloads.
 */

/** A file uploaded for the message being written. */
export interface DraftAttachment {
  /** Where the file is, such as `session://cat.png`. */
  ref: string;
  /** The file's name in the session. */
  name: string;
  mediaType: string;
  kind: MediaKind;
  /** An object URL of the local file, for a thumbnail or to play it back. */
  previewUrl: string | undefined;
}

export interface SessionDraft {
  text: string;
  items: DraftAttachment[];
  uploading: number;
}

export const EMPTY_DRAFT: SessionDraft = { text: "", items: [], uploading: 0 };

/** Releases the preview of an attachment. */
export function revokePreview(item: DraftAttachment): void {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
}

interface DraftsState {
  drafts: Record<string, SessionDraft>;
  patch: (sessionId: string, change: (d: SessionDraft) => SessionDraft) => void;
  /** Forgets a session's draft and releases its previews. */
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

/** A session's draft, empty when it has none. */
export const useDraft = (sessionId: string): SessionDraft =>
  useDrafts((s) => s.drafts[sessionId] ?? EMPTY_DRAFT);

/** For a tab that closes and a session that goes to the trash. */
export const dropDraft = (sessionId: string): void =>
  useDrafts.getState().drop(sessionId);

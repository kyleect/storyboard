import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useComputedColorScheme } from "@mantine/core";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import type { MediaType } from "@harness/core";

/*
 * The text editor of the Files view: CodeMirror filling its container, with
 * line numbers, undo, search, and Markdown or JSON highlighting by the
 * file's type. The text is the source of truth: the parent keeps it, and
 * text from the parent that differs from the editor's replaces it.
 */

const layout = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--mantine-color-body)",
    color: "var(--mantine-color-text)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--mantine-font-family-monospace)",
    fontSize: "13px",
    lineHeight: "1.55",
  },
  ".cm-gutters": {
    backgroundColor: "var(--mantine-color-body)",
    color: "var(--mantine-color-dimmed)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--mantine-color-default-hover)",
  },
  ".cm-content": { padding: "8px 0" },
});

const dark = EditorView.theme({}, { dark: true });

const languageFor = (mediaType: MediaType): Extension[] =>
  mediaType === "text/markdown"
    ? [markdown()]
    : mediaType === "application/json"
      ? [json()]
      : [];

export interface Cursor {
  line: number;
  column: number;
}

export function TextEditor({
  value,
  mediaType,
  onChange,
  onSave,
  onCursor,
  readOnly = false,
  label,
}: {
  value: string;
  mediaType: MediaType;
  onChange: (text: string) => void;
  /** Ctrl/Cmd+S. */
  onSave?: () => void;
  onCursor?: (cursor: Cursor) => void;
  readOnly?: boolean;
  /** For screen readers. */
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onSave, onCursor });
  useEffect(() => {
    latest.current = { onChange, onSave, onCursor };
  }, [onChange, onSave, onCursor]);
  const scheme = useComputedColorScheme("light");

  // Made once per mount, type, read-only state and colour scheme; the text
  // is applied below, because remaking the editor would lose the cursor.
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          layout,
          ...languageFor(mediaType),
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ "aria-label": label }),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  latest.current.onSave?.();
                  return true;
                },
              },
            ]),
          ),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              latest.current.onCursor?.({
                line: line.number,
                column: head - line.from + 1,
              });
            }
          }),
          ...(scheme === "dark" ? [dark] : []),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaType, readOnly, label, scheme]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) {
      editor.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={host} style={{ height: "100%", minHeight: 0 }} />;
}

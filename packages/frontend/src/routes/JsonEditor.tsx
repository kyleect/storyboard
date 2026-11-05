import { json } from "@codemirror/lang-json";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useComputedColorScheme } from "@mantine/core";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

/*
 * A JSON text editor (schemas and data design, decision 15): CodeMirror with
 * JSON highlighting and bracket matching. The text is the source of truth;
 * the parent checks it when it is used.
 */

const dark = EditorView.theme({}, { dark: true });

export function JsonEditor({
  value,
  onChange,
  readOnly = false,
  label,
}: {
  value: string;
  onChange: (text: string) => void;
  readOnly?: boolean;
  /** For screen readers. */
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  }, [onChange]);
  const scheme = useComputedColorScheme("light");

  // The editor is made once per mount (and colour scheme); text from the
  // parent that differs from the editor's replaces it below.
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          json(),
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current(u.state.doc.toString());
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
    // `value` is applied below; remaking the editor would lose the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, label, scheme]);

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

  return (
    <div
      ref={host}
      style={{
        border: "1px solid var(--mantine-color-default-border)",
        borderRadius: "var(--mantine-radius-sm)",
        minHeight: 240,
        maxHeight: "60vh",
        overflow: "auto",
        fontSize: 13,
      }}
    />
  );
}

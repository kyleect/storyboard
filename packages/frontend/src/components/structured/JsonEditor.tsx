import { json } from "@codemirror/lang-json";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useComputedColorScheme, Box } from "@mantine/core";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

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
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  }, [onChange]);
  const scheme = useComputedColorScheme("light");

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
    <Box
      ref={host}
      bd="1px solid var(--mantine-color-default-border)"
      bdrs="sm"
      mih={240}
      mah="60vh"
      fz={13}
      style={{ overflow: "auto" }}
    />
  );
}

import { TextInput, Title, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { showError } from "./SessionActions";

/**
 * A session title or project name; click to edit it in place (sessions and
 * projects design, Q1, Q13b). Enter or leaving the field saves, Escape
 * cancels. Trimmed; empty is not saved.
 */
export function EditableTitle({
  title,
  label,
  disabled,
  onSave,
}: {
  title: string;
  /** The field's accessible name. */
  label: string;
  disabled: boolean;
  onSave: (title: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (draft === null || disabled) {
    return (
      <UnstyledButton
        onClick={() => setDraft(title)}
        disabled={disabled}
        title={disabled ? undefined : "Rename"}
        style={{ minWidth: 0 }}
      >
        <Title order={3} lineClamp={1}>
          {title}
        </Title>
      </UnstyledButton>
    );
  }

  const save = () => {
    // Enter saves, and the field then loses focus: save once.
    if (saving) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === title) {
      setDraft(null);
      return;
    }
    setSaving(true);
    onSave(trimmed)
      .then(() => setDraft(null))
      .catch(showError("Could not rename"))
      .finally(() => setSaving(false));
  };

  return (
    <TextInput
      style={{ flex: 1 }}
      size="md"
      autoFocus
      aria-label={label}
      value={draft}
      disabled={saving}
      error={draft.trim() ? null : "A title is required"}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        } else if (e.key === "Escape") {
          setDraft(null);
        }
      }}
    />
  );
}

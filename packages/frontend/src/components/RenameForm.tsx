import { Button, Group, Stack, TextInput } from "@mantine/core";
import { useState } from "react";

export function RenameForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (title: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const trimmed = title.trim();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();

        if (!trimmed) return;

        setSaving(true);
        onSubmit(trimmed).catch((err: unknown) => {
          setSaving(false);
          setError(err instanceof Error ? err.message : String(err));
        });
      }}
    >
      <Stack gap="sm">
        <TextInput
          label="Title"
          data-autofocus
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value);
            setError(null);
          }}
          error={error ?? (trimmed ? null : "A title is required")}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!trimmed} loading={saving}>
            Rename
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

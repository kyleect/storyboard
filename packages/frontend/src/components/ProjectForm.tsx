import { Button, Group, Stack, Textarea, TextInput } from "@mantine/core";
import { useState } from "react";
import type { ProjectColor } from "@harness/core";
import { ProjectColorPicker } from "./ProjectColorPicker";

export function ProjectForm({
  submitLabel,
  onSubmit,
  onCancel,
}: {
  submitLabel: string;
  onSubmit: (fields: {
    name: string;
    description: string;
    color: ProjectColor | null;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<ProjectColor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();

        if (!trimmed) return;

        setSaving(true);
        onSubmit({ name: trimmed, description, color }).catch(
          (err: unknown) => {
            setSaving(false);
            setError(err instanceof Error ? err.message : String(err));
          },
        );
      }}
    >
      <Stack gap="sm">
        <TextInput
          label="Name"
          data-autofocus
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            setError(null);
          }}
          error={error}
        />
        <Textarea
          label="Description"
          autosize
          minRows={2}
          maxRows={8}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <ProjectColorPicker value={color} onChange={setColor} />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!trimmed} loading={saving}>
            {submitLabel}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

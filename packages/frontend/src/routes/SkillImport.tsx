import {
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  Radio,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type SkillOwner } from "../api";
import { skillKeys } from "../queries";
import { zipPickedFolder } from "../skill-zip";

/*
 * Importing a skill from a zip or a folder (skills folders design, decisions
 * 15 to 17). Nothing is saved until the person has seen what is in it: the
 * backend reads the archive and answers with the skill's name, description and
 * files, and whether the name is already taken here. A taken name asks:
 * replace it (a new version of that skill), import under another name, or
 * cancel.
 */

type Resolution = "replace" | "rename";

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${Math.round(n / 1024)} KB`
      : `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** The dialog for one picked archive; closing it forgets the archive. */
export function SkillImportDialog({
  owner,
  zip,
  onClose,
  onImported,
}: {
  owner: SkillOwner;
  /** The archive, already a zip (a picked folder is zipped before this). */
  zip: Blob;
  onClose: () => void;
  /** The name the skill was saved under. */
  onImported?: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: [...skillKeys.all, "import-preview", zip],
    queryFn: () => api.previewSkillImport(owner, zip),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const [resolution, setResolution] = useState<Resolution>("rename");
  const [newName, setNewName] = useState("");

  const run = useMutation({
    mutationFn: () => {
      const p = preview.data;
      if (!p) throw new Error("Nothing to import.");
      if (!p.clash) return api.importSkill(owner, zip);
      return resolution === "replace"
        ? api.importSkill(owner, zip, { resolve: "replace" })
        : api.importSkill(owner, zip, {
            resolve: "rename",
            name: newName.trim(),
          });
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: skillKeys.all });
      for (const w of saved.warnings) {
        notifications.show({ color: "yellow", title: "Imported", message: w });
      }
      onImported?.(saved.name);
      onClose();
    },
  });

  const p = preview.data;
  const clashDeleted = p?.clash?.deleted === true;
  const canImport =
    p !== undefined &&
    !run.isPending &&
    (!p.clash ||
      (resolution === "replace" && !clashDeleted) ||
      (resolution === "rename" && newName.trim() !== ""));

  return (
    <Modal opened onClose={onClose} size="lg" title="Import a skill">
      {preview.isPending && <Loader size="sm" aria-label="Reading the file" />}
      {preview.isError && (
        <Stack gap="sm">
          <Alert color="red">{preview.error.message}</Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
          </Group>
        </Stack>
      )}
      {p && (
        <Stack gap="sm">
          <Stack gap={2}>
            <Text fw={600} ff="monospace">
              {p.name}
            </Text>
            <Text size="sm">{p.description}</Text>
          </Stack>
          <Text size="xs" c="dimmed">
            {p.files.length} {p.files.length === 1 ? "file" : "files"}
          </Text>
          <ScrollArea.Autosize mah={180}>
            <Stack gap={2}>
              {p.files.map((f) => (
                <Group key={f.path} justify="space-between" wrap="nowrap">
                  <Text size="sm" ff="monospace" truncate>
                    {f.path}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {size(f.size)}
                  </Text>
                </Group>
              ))}
            </Stack>
          </ScrollArea.Autosize>
          {p.warnings.map((w) => (
            <Alert key={w} color="yellow" p="xs">
              {w}
            </Alert>
          ))}
          {p.clash && (
            <Radio.Group
              value={resolution}
              onChange={(v) => setResolution(v as Resolution)}
              label={`A skill named “${p.name}” ${clashDeleted ? "was deleted here" : "already exists here"}.`}
            >
              <Stack gap="xs" mt="xs">
                <Radio
                  value="replace"
                  disabled={clashDeleted}
                  label="Replace it"
                  description={
                    clashDeleted
                      ? "Restore it first, or import under another name."
                      : "The import becomes a new version of that skill. The earlier versions are kept."
                  }
                />
                <Radio
                  value="rename"
                  label="Import under another name"
                  description="The name in SKILL.md is changed to match."
                />
                {resolution === "rename" && (
                  <TextInput
                    aria-label="New name"
                    placeholder="new-skill-name"
                    value={newName}
                    onChange={(e) => setNewName(e.currentTarget.value)}
                  />
                )}
              </Stack>
            </Radio.Group>
          )}
          {run.isError && <Alert color="red">{run.error.message}</Alert>}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!canImport}
              loading={run.isPending}
              onClick={() => run.mutate()}
            >
              Import
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

/**
 * Turns what the person picked into the zip to import: a zip as it is, or the
 * files of a folder zipped here.
 */
export async function archiveFrom(
  files: readonly File[],
  kind: "zip" | "folder",
): Promise<Blob> {
  if (kind === "folder") return zipPickedFolder(files);
  const [file] = files;
  if (!file) throw new Error("No file was picked.");
  return file;
}

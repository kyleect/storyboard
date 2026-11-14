import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Loader,
  ScrollArea,
  Text,
  Tooltip,
  Stack,
  Group,
} from "@mantine/core";
import { when } from "../../lib/format";
import { confirmAction } from "../../lib/confirm";
import type { ProjectColor } from "@harness/core";
import { IconHistory, IconMarkdown, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ExplorerSource } from "../../lib/explorer-source";
import {
  confirmDelete,
  TypeBadge,
  useRefresh,
  ValueView,
  VersionsModal,
} from "./FileViews";
import { Markdown } from "../Markdown";
import { TextEditor, type Cursor } from "./TextEditor";
import { showError } from "../../lib/notify";

export interface Draft {
  text: string;
  base: string;
}

export function FileTab({
  source,
  rootLabel,
  rootColor,
  fileKey,
  readOnly,
  broadNote,
  draft,
  onDraft,
  onKeep,
  onCursor,
  onPreview,
}: {
  source: ExplorerSource;
  rootLabel: string;
  rootColor?: ProjectColor | undefined;
  fileKey: string;
  readOnly: string | undefined;
  broadNote: string | undefined;
  draft: Draft | undefined;
  onDraft: (draft: Draft | undefined) => void;
  onKeep: () => void;
  onCursor: (cursor: Cursor) => void;
  onPreview?: (() => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const refresh = useRefresh(source);
  const [versions, setVersions] = useState(false);
  const file = useQuery({
    queryKey: source.keys.detail(fileKey),
    queryFn: () => source.get(fileKey),
  });
  const save = useMutation({
    mutationFn: (text: string) =>
      source.write(fileKey, file.data?.mediaType ?? "text/plain", text),
    onSuccess: async (saved) => {
      queryClient.setQueryData(source.keys.detail(fileKey), saved);
      onDraft(undefined);
      await refresh();
    },
    onError: showError("Could not save the file"),
  });
  const remove = useMutation({
    mutationFn: () => source.remove(fileKey),
    onSuccess: refresh,
    onError: showError("Could not delete the file"),
  });

  if (file.isPending) return <Loader size="sm" m="md" />;
  if (file.isError) {
    return (
      <Alert color="red" m="md">
        {file.error.message}
      </Alert>
    );
  }
  const f = file.data;
  const binary = f.blob !== undefined;
  const editable = !binary && !f.deleted && readOnly === undefined;
  const text = draft?.text ?? f.value;
  const changedElsewhere = draft !== undefined && draft.base !== f.value;

  const doSave = () => {
    if (!editable || draft === undefined) return;
    if (broadNote === undefined) {
      save.mutate(draft.text);
      return;
    }
    confirmAction({
      title: `Save to the ${rootLabel} file “${fileKey}”?`,
      message: <>{broadNote}</>,
      confirm: "Save",
      cancel: "Cancel",
      onConfirm: () => save.mutate(draft.text),
    });
  };

  return (
    <Stack gap={0} h="100%" mih={0}>
      <Group
        px="sm"
        py={4}
        gap={8}
        justify="space-between"
        wrap="nowrap"
        style={{
          borderBottom: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <Group gap={8} wrap="nowrap" miw={0}>
          <Text size="xs" c="dimmed" truncate>
            <Text span inherit {...(rootColor ? { c: rootColor } : {})}>
              {rootLabel}
            </Text>{" "}
            › {fileKey.split("/").join(" › ")}
          </Text>
          <TypeBadge {...(f.mediaType ? { mediaType: f.mediaType } : {})} />
          {f.deleted && (
            <Text size="xs" c="red">
              Deleted {when(f.updatedAt)}
            </Text>
          )}
          {!f.deleted && readOnly && (
            <Text size="xs" c="dimmed" truncate>
              {readOnly}
            </Text>
          )}
        </Group>
        <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
          {editable && (
            <Button
              size="compact-xs"
              disabled={draft === undefined}
              loading={save.isPending}
              onClick={doSave}
            >
              Save
            </Button>
          )}
          {onPreview && f.mediaType === "text/markdown" && !f.deleted && (
            <Tooltip
              label="Open the rendered Markdown in a new tab"
              openDelay={400}
            >
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Preview"
                onClick={onPreview}
              >
                <IconMarkdown size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label="Versions" openDelay={400}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Versions (${f.versions.length})`}
              onClick={() => setVersions(true)}
            >
              <IconHistory size={16} />
            </ActionIcon>
          </Tooltip>
          {!f.deleted && readOnly === undefined && (
            <Tooltip label="Delete" openDelay={400}>
              <ActionIcon
                variant="subtle"
                color="red"
                size="sm"
                aria-label="Delete"
                loading={remove.isPending}
                onClick={() =>
                  confirmDelete(`“${f.key}”`, () => remove.mutate())
                }
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>

      {changedElsewhere && (
        <Alert color="yellow" py={4} radius={0}>
          <Group gap={8} justify="space-between" wrap="nowrap">
            <Text size="xs">
              This file changed since you started editing. Saving replaces that
              change with your text.
            </Text>
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => onDraft(undefined)}
            >
              Discard mine
            </Button>
          </Group>
        </Alert>
      )}

      <Box flex={1} mih={0}>
        {binary || f.deleted || f.mediaType === undefined ? (
          <ScrollArea h="100%">
            <Box p="md">
              {f.deleted && (
                <Text size="sm" c="dimmed" mb="xs">
                  Deleted. Open Versions to restore it.
                </Text>
              )}
              <ValueView
                {...(f.mediaType ? { mediaType: f.mediaType } : {})}
                value={f.value}
                blob={f.blob}
              />
            </Box>
          </ScrollArea>
        ) : (
          <TextEditor
            value={text}
            mediaType={f.mediaType}
            readOnly={!editable}
            label={`Editing ${fileKey}`}
            onChange={(next) => {
              if (next === f.value) {
                onDraft(undefined);
                return;
              }
              onDraft({ text: next, base: draft?.base ?? f.value });
              onKeep();
            }}
            onSave={doSave}
            onCursor={onCursor}
          />
        )}
      </Box>

      {versions && (
        <VersionsModal
          source={source}
          file={f}
          readOnly={readOnly !== undefined}
          onClose={() => setVersions(false)}
        />
      )}
    </Stack>
  );
}

export function PreviewTab({
  source,
  fileKey,
  draft,
}: {
  source: ExplorerSource;
  fileKey: string;
  draft: Draft | undefined;
}) {
  const file = useQuery({
    queryKey: source.keys.detail(fileKey),
    queryFn: () => source.get(fileKey),
  });
  if (file.isPending) return <Loader size="sm" m="md" />;
  if (file.isError) {
    return (
      <Alert color="red" m="md">
        {file.error.message}
      </Alert>
    );
  }
  const value = draft?.text ?? file.data.value;
  return (
    <ScrollArea h="100%">
      <Box p="md" maw={820} mx="auto">
        {value.trim() === "" ? (
          <Text size="sm" c="dimmed">
            (empty)
          </Text>
        ) : (
          <Markdown>{value}</Markdown>
        )}
      </Box>
    </ScrollArea>
  );
}

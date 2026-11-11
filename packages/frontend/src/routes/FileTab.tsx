import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Loader,
  ScrollArea,
  Text,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconHistory, IconMarkdown, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type EntryScope } from "../api";
import { rootLabel, type RootId } from "../files-explorer";
import { entryKeys } from "../queries";
import {
  confirmDelete,
  TypeBadge,
  useRefresh,
  ValueView,
  VersionsModal,
  when,
} from "./Entries";
import { Markdown } from "./Markdown";
import { showError } from "./SessionActions";
import { TextEditor, type Cursor } from "./TextEditor";

/*
 * What a tab shows. A text file is an editor: the text typed and not yet
 * saved is the tab's draft, kept by the parent so it survives switching
 * tabs. An image or audio file is previewed, and a deleted file is shown
 * with its last value; neither has an editor.
 */

/** Text typed and not saved, with the saved text it started from. */
export interface Draft {
  text: string;
  base: string;
}

export function FileTab({
  scope,
  root,
  fileKey,
  readOnly,
  higher,
  draft,
  onDraft,
  onKeep,
  onCursor,
  onPreview,
}: {
  scope: EntryScope;
  root: RootId;
  fileKey: string;
  /** Why the file cannot be changed, when it cannot. */
  readOnly: string | undefined;
  /** The file is in a higher scope than the page it is edited from. */
  higher: boolean;
  draft: Draft | undefined;
  onDraft: (draft: Draft | undefined) => void;
  /** The tab was edited, so it stays open. */
  onKeep: () => void;
  onCursor: (cursor: Cursor) => void;
  onPreview: () => void;
}) {
  const queryClient = useQueryClient();
  const refresh = useRefresh(scope);
  const [versions, setVersions] = useState(false);
  const file = useQuery({
    queryKey: entryKeys.detail(scope, "file", fileKey),
    queryFn: () => api.getEntry(scope, "file", fileKey),
  });
  const save = useMutation({
    mutationFn: (text: string) =>
      api.writeFile(scope, fileKey, file.data?.mediaType ?? "text/plain", text),
    onSuccess: async (saved) => {
      queryClient.setQueryData(entryKeys.detail(scope, "file", fileKey), saved);
      onDraft(undefined);
      await refresh();
    },
    onError: showError("Could not save the file"),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteEntry(scope, "file", fileKey),
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
    if (!higher) {
      save.mutate(draft.text);
      return;
    }
    // A higher scope reaches more sessions than this one (Kylee, 2026-11-11).
    modals.openConfirmModal({
      title: `Save to the ${rootLabel(root)} file “${fileKey}”?`,
      children: (
        <Text size="sm">
          {rootLabel(root) === "Global"
            ? "Every session sees this file."
            : "Every session in this project sees this file."}
        </Text>
      ),
      labels: { confirm: "Save", cancel: "Cancel" },
      onConfirm: () => save.mutate(draft.text),
    });
  };

  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <Box
        px="sm"
        py={4}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          borderBottom: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <Box
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          <Text size="xs" c="dimmed" truncate>
            {rootLabel(root)} › {fileKey.split("/").join(" › ")}
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
        </Box>
        <Box
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            flexShrink: 0,
          }}
        >
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
          {f.mediaType === "text/markdown" && !f.deleted && (
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
        </Box>
      </Box>

      {changedElsewhere && (
        <Alert color="yellow" py={4} radius={0}>
          <Box
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
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
          </Box>
        </Alert>
      )}

      <Box style={{ flex: 1, minHeight: 0 }}>
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
          scope={scope}
          kind="file"
          entry={f}
          readOnly={readOnly !== undefined}
          onClose={() => setVersions(false)}
        />
      )}
    </Box>
  );
}

/** The rendered Markdown of a file, in its own tab; follows unsaved text. */
export function PreviewTab({
  scope,
  fileKey,
  draft,
}: {
  scope: EntryScope;
  fileKey: string;
  draft: Draft | undefined;
}) {
  const file = useQuery({
    queryKey: entryKeys.detail(scope, "file", fileKey),
    queryFn: () => api.getEntry(scope, "file", fileKey),
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

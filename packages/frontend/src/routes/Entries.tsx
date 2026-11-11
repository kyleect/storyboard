import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Image,
  Loader,
  Modal,
  NavLink,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Textarea,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fileNameProblem,
  mediaKindOf,
  type BlobRef,
  type EntryKind,
  type MediaType,
} from "@harness/core";
import {
  api,
  type DerivedText,
  type Entry,
  type EntryDetail,
  type EntryScope,
  type EntryVersion,
} from "../api";
import { blobKeys, entryKeys } from "../queries";
import { Markdown } from "./Markdown";
import { showError } from "./SessionActions";

/*
 * Viewing and editing files and memory notes (files and memory design,
 * decisions 31 to 35; plan U1 to U8). Files: a list on the left and the
 * selected file on the right. Notes: one list of cards. Earlier versions
 * open in a dialog, where one can be made current again.
 */

const FILE_TYPES: { value: MediaType; label: string }[] = [
  { value: "text/plain", label: "Plain" },
  { value: "text/markdown", label: "Markdown" },
  { value: "application/json", label: "JSON" },
];

/** What is wrong with a name or path, or undefined when it is fine (D50). */
export const nameError = (name: string): string | undefined => {
  if (name === "") return undefined;
  const problem = fileNameProblem(name);
  return problem ? `Not a valid name: ${problem}.` : undefined;
};

/**
 * Plain as text; JSON pretty-printed (plan U1); Markdown rendered, with a
 * switch to its source (markdown rendering plan M2, M3). Exported for tests.
 */
export function ValueView({
  mediaType,
  value,
  blob,
}: {
  mediaType?: MediaType;
  value: string;
  /** Binary files: the bytes to show. */
  blob?: BlobRef | undefined;
}) {
  const [showSource, setShowSource] = useState(false);
  if (mediaType && mediaKindOf(mediaType) && blob) {
    return <BinaryPreview mediaType={mediaType} blob={blob} />;
  }
  if (mediaType === "text/markdown" && value !== "") {
    return (
      <Stack gap="xs">
        <SegmentedControl
          size="xs"
          w="fit-content"
          value={showSource ? "source" : "rendered"}
          onChange={(v) => setShowSource(v === "source")}
          data={[
            { value: "rendered", label: "Rendered" },
            { value: "source", label: "Source" },
          ]}
        />
        {showSource ? (
          <SourceView value={value} />
        ) : (
          <Paper p="sm" withBorder>
            <Markdown>{value}</Markdown>
          </Paper>
        )}
      </Stack>
    );
  }
  if (mediaType === "application/json") {
    let pretty = value;
    try {
      pretty = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      // Stored JSON is checked on write; show it as is if it does not parse.
    }
    return <Code block>{pretty}</Code>;
  }
  return <SourceView value={value} />;
}

/** An image viewer or audio player for a binary file; no text editor. */
function BinaryPreview({
  mediaType,
  blob,
}: {
  mediaType: MediaType;
  blob: BlobRef;
}) {
  const bytes = useQuery({
    queryKey: blobKeys.file(blob.hash),
    queryFn: () => api.blobUrl(blob.hash),
    // The bytes under a hash never change, and the object URL has to stay
    // valid for as long as the page is open.
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const size =
    blob.size < 1024 * 1024
      ? `${Math.max(1, Math.round(blob.size / 1024))} KB`
      : `${(blob.size / (1024 * 1024)).toFixed(1)} MB`;
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        {mediaType}, {size}
      </Text>
      {bytes.isPending && <Loader size="sm" aria-label="Loading the file" />}
      {bytes.isError && (
        <Alert color="red">
          Could not load the file: {bytes.error.message}
        </Alert>
      )}
      {bytes.data && mediaKindOf(mediaType) === "image" && (
        <Image
          src={bytes.data}
          alt="Preview"
          maw="100%"
          mah="60vh"
          fit="contain"
          radius="sm"
        />
      )}
      {bytes.data && mediaKindOf(mediaType) === "audio" && (
        <audio controls src={bytes.data} aria-label="Play the file" />
      )}
      <DerivedTextField hash={blob.hash} />
    </Stack>
  );
}

/**
 * The text that stands for an image or audio file (files unification design,
 * D18, D43, D44): a description or transcript, written by the Media
 * Describer or by the user. It is searched, and given to a model that cannot
 * take the file. A failed generation shows "Not generated" and a Retry.
 */
export function DerivedTextField({ hash }: { hash: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: blobKeys.text(hash),
    queryFn: () => api.getDerivedText(hash),
    // While it is being written, look again.
    refetchInterval: (q) => (q.state.data?.state === "pending" ? 2000 : false),
  });
  const describer = useQuery({
    queryKey: blobKeys.describer(),
    queryFn: api.getMediaDescriber,
  });
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const refresh = (value: DerivedText) => {
    queryClient.setQueryData(blobKeys.text(hash), value);
    setDraft(undefined);
  };
  const save = useMutation({
    mutationFn: (text: string) => api.setDerivedText(hash, text),
    onSuccess: refresh,
    onError: showError("Could not save the text"),
  });
  const retry = useMutation({
    mutationFn: () => api.describeFile(hash),
    onSuccess: refresh,
    onError: showError("Could not start the description"),
  });
  if (query.isPending)
    return <Loader size="xs" aria-label="Loading the text" />;
  if (query.isError) {
    return <Alert color="red">{query.error.message}</Alert>;
  }
  const { text, state } = query.data;
  const shown = draft ?? text;
  const on = describer.data?.enabled ?? false;
  const status: Record<string, string> = {
    none: "No text yet.",
    pending: "Writing a description…",
    generated: "Written by the Media Describer.",
    edited: "Edited by you.",
    failed: text === "" ? "Not generated." : "The last attempt failed.",
  };
  return (
    <Stack gap={4}>
      <Textarea
        label="Text for search and for models that cannot see or hear this file"
        autosize
        minRows={2}
        maxRows={10}
        value={shown}
        onChange={(e) => setDraft(e.currentTarget.value)}
        disabled={state === "pending"}
      />
      <Group gap="xs">
        <Text size="xs" c={state === "failed" ? "red" : "dimmed"}>
          {status[state]}
        </Text>
        {state === "pending" && <Loader size="xs" />}
        {draft !== undefined && draft !== text && (
          <Button
            size="xs"
            loading={save.isPending}
            onClick={() => save.mutate(draft)}
          >
            Save text
          </Button>
        )}
        {state !== "pending" && (
          <Button
            size="xs"
            variant="default"
            disabled={!on}
            loading={retry.isPending}
            onClick={() => retry.mutate()}
          >
            {state === "failed"
              ? "Retry"
              : text === ""
                ? "Generate"
                : "Write again"}
          </Button>
        )}
        {!on && state !== "pending" && (
          <Text size="xs" c="dimmed">
            Choose a Media describer model in Settings to generate it.
          </Text>
        )}
      </Group>
    </Stack>
  );
}

/** A value as stored, in monospace. */
function SourceView({ value }: { value: string }) {
  return (
    <Paper p="sm" withBorder>
      <Text size="sm" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
        {value === "" ? (
          <Text span c="dimmed">
            (empty)
          </Text>
        ) : (
          value
        )}
      </Text>
    </Paper>
  );
}

export function TypeBadge({ mediaType }: { mediaType?: MediaType }) {
  if (!mediaType) return null;
  return (
    <Badge size="xs" variant="light" color="gray">
      {FILE_TYPES.find((t) => t.value === mediaType)?.label ?? mediaType}
    </Badge>
  );
}

export const when = (iso: string) =>
  iso ? new Date(iso).toLocaleString() : "";

/** Refreshes a scope's lists and open entries after a change. */
export function useRefresh(scope: EntryScope) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: entryKeys.inScope(scope) });
}

/** Earlier versions of one file or note; one can be made current. */
export function VersionsModal({
  scope,
  kind,
  entry,
  readOnly,
  onClose,
}: {
  scope: EntryScope;
  kind: EntryKind;
  entry: EntryDetail;
  readOnly: boolean;
  onClose: () => void;
}) {
  const refresh = useRefresh(scope);
  const newestFirst = [...entry.versions].reverse();
  const [picked, setPicked] = useState<EntryVersion | undefined>(
    newestFirst[0],
  );
  const latest = entry.versions.at(-1);
  const restore = useMutation({
    mutationFn: (seq: number) => api.restoreEntry(scope, kind, entry.key, seq),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: showError("Could not restore the version"),
  });
  const isCurrent = picked?.seq === latest?.seq && !entry.deleted;

  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={`Versions of ${kind === "file" ? entry.key : "note " + entry.key}`}
    >
      <Group align="flex-start" wrap="nowrap" gap="md">
        <ScrollArea.Autosize mah="60vh" w={240} style={{ flexShrink: 0 }}>
          {newestFirst.map((v) => (
            <NavLink
              key={v.seq}
              active={picked?.seq === v.seq}
              onClick={() => setPicked(v)}
              label={
                <Group gap={4}>
                  <Text size="sm">#{v.seq}</Text>
                  <Badge
                    size="xs"
                    variant="light"
                    color={v.by === "user" ? "blue" : "grape"}
                  >
                    {v.by === "user" ? "You" : "Model"}
                  </Badge>
                  {v.deleted && (
                    <Badge size="xs" variant="light" color="red">
                      deleted
                    </Badge>
                  )}
                </Group>
              }
              description={when(v.createdAt)}
            />
          ))}
        </ScrollArea.Autosize>
        {picked && (
          <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between">
              <Group gap="xs">
                <TypeBadge
                  {...(picked.mediaType ? { mediaType: picked.mediaType } : {})}
                />
                {picked.deleted && (
                  <Text size="sm" c="dimmed">
                    Deleted here; the value it had is shown.
                  </Text>
                )}
              </Group>
              {!readOnly && (
                <Button
                  size="xs"
                  disabled={picked.deleted || isCurrent}
                  loading={restore.isPending}
                  onClick={() => restore.mutate(picked.seq)}
                >
                  {isCurrent ? "Current" : "Make current"}
                </Button>
              )}
            </Group>
            <ScrollArea.Autosize mah="55vh">
              <ValueView
                {...(picked.mediaType ? { mediaType: picked.mediaType } : {})}
                value={picked.value}
                blob={picked.blob}
              />
            </ScrollArea.Autosize>
          </Stack>
        )}
      </Group>
    </Modal>
  );
}

export function confirmDelete(what: string, onConfirm: () => void) {
  modals.openConfirmModal({
    title: `Delete ${what}?`,
    children: (
      <Text size="sm">
        Its earlier versions are kept, and it can be restored from them.
      </Text>
    ),
    labels: { confirm: "Delete", cancel: "Cancel" },
    confirmProps: { color: "red" },
    onConfirm,
  });
}

/** Shown above a panel when changes are not allowed. */
function ReadOnlyNote({ reason }: { reason: string | undefined }) {
  if (!reason) return null;
  return (
    <Text size="sm" c="dimmed">
      {reason}
    </Text>
  );
}

/**
 * A scope's memory notes as cards, newest change first (plan U8). Only the
 * model creates notes; here they can be edited, deleted and restored.
 */
export function NotesPanel({
  scope,
  readOnly,
}: {
  scope: EntryScope;
  readOnly?: string | undefined;
}) {
  const [showDeleted, setShowDeleted] = useState(false);
  const list = useQuery({
    queryKey: entryKeys.list(scope, "note", showDeleted),
    queryFn: () => api.listEntries(scope, "note", showDeleted),
  });
  const notes = [...(list.data ?? [])].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  return (
    <Stack gap="xs" maw={800}>
      <ReadOnlyNote reason={readOnly} />
      <Switch
        size="xs"
        label="Show deleted"
        checked={showDeleted}
        onChange={(e) => setShowDeleted(e.currentTarget.checked)}
      />
      {list.isPending && <Loader size="sm" />}
      {list.isError && <Alert color="red">{list.error.message}</Alert>}
      {list.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          No memory notes. Only the model creates notes.
        </Text>
      )}
      {notes.map((n) => (
        <NoteCard key={n.key} scope={scope} note={n} readOnly={!!readOnly} />
      ))}
    </Stack>
  );
}

function NoteCard({
  scope,
  note,
  readOnly,
}: {
  scope: EntryScope;
  note: Entry;
  readOnly: boolean;
}) {
  const refresh = useRefresh(scope);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.value);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const detail = useQuery({
    queryKey: entryKeys.detail(scope, "note", note.key),
    queryFn: () => api.getEntry(scope, "note", note.key),
    enabled: versionsOpen,
  });
  const save = useMutation({
    mutationFn: () => api.editNote(scope, note.key, draft),
    onSuccess: async () => {
      await refresh();
      setEditing(false);
    },
    onError: showError("Could not save the note"),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteEntry(scope, "note", note.key),
    onSuccess: async () => {
      await refresh();
    },
    onError: showError("Could not delete the note"),
  });

  return (
    <Card withBorder padding="sm" opacity={note.deleted ? 0.6 : 1}>
      {editing ? (
        <Stack gap="xs">
          <Textarea
            autosize
            minRows={2}
            maxRows={12}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <Group gap="xs">
            <Button
              size="xs"
              disabled={draft.trim() === "" || draft === note.value}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                setDraft(note.value);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </Group>
        </Stack>
      ) : (
        <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
          {note.value}
        </Text>
      )}
      <Group justify="space-between" mt="xs">
        <Group gap="xs">
          <Badge size="xs" variant="light" color="gray" tt="none">
            {note.key}
          </Badge>
          {note.deleted && (
            <Badge size="xs" variant="light" color="red">
              deleted
            </Badge>
          )}
          <Text size="xs" c="dimmed">
            {when(note.updatedAt)}
          </Text>
        </Group>
        {!editing && (
          <Group gap="xs">
            <Anchor
              size="xs"
              component="button"
              onClick={() => setVersionsOpen(true)}
            >
              Versions
            </Anchor>
            {!readOnly && !note.deleted && (
              <>
                <Anchor
                  size="xs"
                  component="button"
                  onClick={() => {
                    setDraft(note.value);
                    setEditing(true);
                  }}
                >
                  Edit
                </Anchor>
                <Anchor
                  size="xs"
                  component="button"
                  c="red"
                  onClick={() =>
                    confirmDelete("this note", () => remove.mutate())
                  }
                >
                  Delete
                </Anchor>
              </>
            )}
          </Group>
        )}
      </Group>
      {versionsOpen && detail.data && (
        <VersionsModal
          scope={scope}
          kind="note"
          entry={detail.data}
          readOnly={readOnly}
          onClose={() => setVersionsOpen(false)}
        />
      )}
    </Card>
  );
}

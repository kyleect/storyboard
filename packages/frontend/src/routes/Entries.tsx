import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Modal,
  NavLink,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import type { EntryKind, FileType } from "@harness/core";
import {
  api,
  entriesKey,
  type Entry,
  type EntryDetail,
  type EntryScope,
  type EntryVersion,
} from "../api";
import { showError } from "./SessionActions";

/*
 * Viewing and editing files and memory notes (files and memory design,
 * decisions 31 to 35; plan U1 to U8). Files: a list on the left and the
 * selected file on the right. Notes: one list of cards. Earlier versions
 * open in a dialog, where one can be made current again.
 */

const FILE_TYPES: { value: FileType; label: string }[] = [
  { value: "plain", label: "Plain" },
  { value: "markdown", label: "Markdown" },
  { value: "json", label: "JSON" },
];

const KEY_RULE = 'Letters, digits, "-", "_" and "." only. Case-sensitive.';
const FILE_KEY = /^[A-Za-z0-9._-]+$/;

/** Plain and Markdown as text; JSON pretty-printed (plan U1). */
function ValueView({ type, value }: { type?: FileType; value: string }) {
  if (type === "json") {
    let pretty = value;
    try {
      pretty = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      // Stored JSON is checked on write; show it as is if it does not parse.
    }
    return <Code block>{pretty}</Code>;
  }
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

function TypeBadge({ type }: { type?: FileType }) {
  if (!type) return null;
  return (
    <Badge size="xs" variant="light" color="gray">
      {FILE_TYPES.find((t) => t.value === type)?.label ?? type}
    </Badge>
  );
}

const when = (iso: string) => (iso ? new Date(iso).toLocaleString() : "");

/** Refreshes a scope's lists and open entries after a change. */
function useRefresh(scope: EntryScope) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: entriesKey(scope) });
}

/** Earlier versions of one file or note; one can be made current. */
function VersionsModal({
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
                <TypeBadge {...(picked.type ? { type: picked.type } : {})} />
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
                {...(picked.type ? { type: picked.type } : {})}
                value={picked.value}
              />
            </ScrollArea.Autosize>
          </Stack>
        )}
      </Group>
    </Modal>
  );
}

function confirmDelete(what: string, onConfirm: () => void) {
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

type FileMode = { mode: "view" } | { mode: "edit" } | { mode: "new" };

/**
 * A scope's files: list on the left, the selected file on the right
 * (plan U6). `readOnly` with a reason when changes are not allowed.
 */
export function FilesPanel({
  scope,
  readOnly,
}: {
  scope: EntryScope;
  readOnly?: string | undefined;
}) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<FileMode>({ mode: "view" });
  const list = useQuery({
    queryKey: [...entriesKey(scope, "file"), "list", showDeleted],
    queryFn: () => api.listEntries(scope, "file", showDeleted),
  });

  return (
    <Group align="flex-start" wrap="nowrap" gap="md" h="100%">
      <Stack gap="xs" w={260} style={{ flexShrink: 0 }}>
        <ReadOnlyNote reason={readOnly} />
        <Group justify="space-between">
          <Switch
            size="xs"
            label="Show deleted"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.currentTarget.checked)}
          />
          {!readOnly && (
            <Button
              size="xs"
              variant="light"
              onClick={() => {
                setSelected(null);
                setMode({ mode: "new" });
              }}
            >
              New file
            </Button>
          )}
        </Group>
        {list.isPending && <Loader size="sm" />}
        {list.isError && <Alert color="red">{list.error.message}</Alert>}
        {list.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            No files.
          </Text>
        )}
        <Stack gap={0}>
          {list.data?.map((f) => (
            <NavLink
              key={f.key}
              active={selected === f.key && mode.mode !== "new"}
              onClick={() => {
                setSelected(f.key);
                setMode({ mode: "view" });
              }}
              label={
                <Text
                  size="sm"
                  {...(f.deleted ? { c: "dimmed" } : {})}
                  truncate
                >
                  {f.key}
                </Text>
              }
              description={when(f.updatedAt)}
              rightSection={
                <Group gap={4} wrap="nowrap">
                  <TypeBadge {...(f.type ? { type: f.type } : {})} />
                  {f.deleted && (
                    <Badge size="xs" variant="light" color="red">
                      deleted
                    </Badge>
                  )}
                </Group>
              }
            />
          ))}
        </Stack>
      </Stack>
      <Stack style={{ flex: 1, minWidth: 0 }}>
        {mode.mode === "new" && !readOnly ? (
          <FileEditor
            scope={scope}
            onSaved={(key) => {
              setSelected(key);
              setMode({ mode: "view" });
            }}
            onCancel={() => setMode({ mode: "view" })}
          />
        ) : selected ? (
          <FileView
            key={selected}
            scope={scope}
            fileKey={selected}
            readOnly={!!readOnly}
            editing={mode.mode === "edit"}
            onEdit={() => setMode({ mode: "edit" })}
            onDone={() => setMode({ mode: "view" })}
            onGone={() => setSelected(null)}
          />
        ) : (
          <Text size="sm" c="dimmed">
            Pick a file on the left.
          </Text>
        )}
      </Stack>
    </Group>
  );
}

function FileView({
  scope,
  fileKey,
  readOnly,
  editing,
  onEdit,
  onDone,
  onGone,
}: {
  scope: EntryScope;
  fileKey: string;
  readOnly: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onGone: () => void;
}) {
  const refresh = useRefresh(scope);
  const [versions, setVersions] = useState(false);
  const file = useQuery({
    queryKey: [...entriesKey(scope, "file"), "one", fileKey],
    queryFn: () => api.getEntry(scope, "file", fileKey),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteEntry(scope, "file", fileKey),
    onSuccess: async () => {
      await refresh();
    },
    onError: showError("Could not delete the file"),
  });

  if (file.isPending) return <Loader size="sm" />;
  if (file.isError) {
    return (
      <Alert color="red" withCloseButton onClose={onGone}>
        {file.error.message}
      </Alert>
    );
  }
  const f = file.data;

  if (editing && !readOnly && !f.deleted) {
    return (
      <FileEditor
        scope={scope}
        existing={f}
        onSaved={onDone}
        onCancel={onDone}
      />
    );
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Title order={5} style={{ wordBreak: "break-all" }}>
            {f.key}
          </Title>
          <TypeBadge {...(f.type ? { type: f.type } : {})} />
          {f.deleted && (
            <Badge size="xs" variant="light" color="red">
              deleted
            </Badge>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="default" onClick={() => setVersions(true)}>
            Versions ({f.versions.length})
          </Button>
          {!readOnly && !f.deleted && (
            <>
              <Button size="xs" variant="light" onClick={onEdit}>
                Edit
              </Button>
              <Button
                size="xs"
                variant="light"
                color="red"
                loading={remove.isPending}
                onClick={() =>
                  confirmDelete(`“${f.key}”`, () => remove.mutate())
                }
              >
                Delete
              </Button>
            </>
          )}
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        {f.deleted ? "Deleted" : "Changed"} {when(f.updatedAt)}
        {f.deleted && ". Open Versions to restore it."}
      </Text>
      <ValueView {...(f.type ? { type: f.type } : {})} value={f.value} />
      {versions && (
        <VersionsModal
          scope={scope}
          kind="file"
          entry={f}
          readOnly={readOnly}
          onClose={() => setVersions(false)}
        />
      )}
    </Stack>
  );
}

/** Creates a file, or edits `existing` (its key cannot change). */
function FileEditor({
  scope,
  existing,
  onSaved,
  onCancel,
}: {
  scope: EntryScope;
  existing?: EntryDetail;
  onSaved: (key: string) => void;
  onCancel: () => void;
}) {
  const refresh = useRefresh(scope);
  const [key, setKey] = useState(existing?.key ?? "");
  const [type, setType] = useState<FileType>(existing?.type ?? "plain");
  const [value, setValue] = useState(existing?.value ?? "");
  const keyError = key !== "" && !FILE_KEY.test(key) ? KEY_RULE : undefined;
  const save = useMutation({
    mutationFn: () => api.writeFile(scope, key, type, value),
    onSuccess: async () => {
      await refresh();
      onSaved(key);
    },
    onError: showError("Could not save the file"),
  });

  return (
    <Stack gap="xs">
      <Group align="flex-end" gap="xs">
        <TextInput
          label="Key"
          description={existing ? undefined : KEY_RULE}
          style={{ flex: 1 }}
          value={key}
          error={keyError}
          disabled={!!existing}
          onChange={(e) => setKey(e.currentTarget.value)}
        />
        <Select
          label="Type"
          w={140}
          allowDeselect={false}
          data={FILE_TYPES}
          value={type}
          onChange={(v) => v && setType(v as FileType)}
        />
      </Group>
      <Textarea
        label="Value"
        autosize
        minRows={8}
        maxRows={30}
        styles={{
          input: { fontFamily: "var(--mantine-font-family-monospace)" },
        }}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
      />
      <Group gap="xs">
        <Button
          size="xs"
          disabled={key === "" || !!keyError}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
        <Button size="xs" variant="default" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Stack>
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
    queryKey: [...entriesKey(scope, "note"), "list", showDeleted],
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
    queryKey: [...entriesKey(scope, "note"), "one", note.key],
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

/** Files and Memory tabs, for the global and project pages. */
function EntriesTabs({
  scope,
  readOnly,
}: {
  scope: EntryScope;
  readOnly?: string | undefined;
}) {
  const [tab, setTab] = useState<string>("files");
  return (
    <Tabs value={tab} onChange={(v) => v && setTab(v)} keepMounted={false}>
      <Tabs.List mb="md">
        <Tabs.Tab value="files">Files</Tabs.Tab>
        <Tabs.Tab value="memory">Memory</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="files">
        <FilesPanel scope={scope} readOnly={readOnly} />
      </Tabs.Panel>
      <Tabs.Panel value="memory">
        <NotesPanel scope={scope} readOnly={readOnly} />
      </Tabs.Panel>
    </Tabs>
  );
}

/** Global files and memory (decision 31). */
export function GlobalEntriesPage() {
  return (
    <Stack gap="md">
      <Title order={3}>Files & memory</Title>
      <Text size="sm" c="dimmed">
        Global: every session sees these.
      </Text>
      <EntriesTabs scope={{ scope: "global" }} />
    </Stack>
  );
}

/** A project's files and memory (decision 32). */
export function ProjectEntriesPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/files" });
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  if (project.isPending) return <Loader />;
  if (project.isError)
    return <Alert color="red">{project.error.message}</Alert>;
  const trashed = project.data.trashed_at !== null;
  return (
    <Stack gap="md">
      <Title order={3}>Files & memory</Title>
      <Text size="sm" c="dimmed">
        Project{" "}
        <Anchor
          renderRoot={(props) => (
            <Link {...props} to="/projects/$projectId" params={{ projectId }} />
          )}
        >
          {project.data.name}
        </Anchor>
        : every session in this project sees these.
      </Text>
      <EntriesTabs
        scope={{ scope: "project", id: projectId }}
        readOnly={
          trashed
            ? "The project is in the trash, so these can be read but not changed."
            : undefined
        }
      />
    </Stack>
  );
}

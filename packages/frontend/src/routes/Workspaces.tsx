import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  api,
  type Workspace,
  type WorkspaceAttachment,
  type WorkspaceTreeEntry,
  type WorkspaceInput,
  type WorkspaceOwner,
} from "../api";
import { workspaceKeys } from "../queries";

/*
 * Workspaces (files unification design, D22 to D26, D46): folders on this
 * computer that projects and sessions attach, read-only or writable. Moving
 * one to the trash never touches the folder.
 */

const failed = (title: string) => (err: Error) =>
  notifications.show({ color: "red", title, message: err.message });

/** Picks a folder on the computer the backend runs on, one level at a time. */
function FolderPicker({
  opened,
  start,
  onPick,
  onClose,
}: {
  opened: boolean;
  start: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(start);
  const dirs = useQuery({
    queryKey: workspaceKeys.dirs(path),
    queryFn: () => api.listDirs(path === "" ? undefined : path),
    enabled: opened,
  });
  const here = dirs.data?.path ?? path;
  return (
    <Modal opened={opened} onClose={onClose} title="Choose a folder" size="md">
      <Stack gap="xs">
        <Text size="sm" ff="monospace" style={{ wordBreak: "break-all" }}>
          {here}
        </Text>
        {dirs.isPending && <Loader size="sm" />}
        {dirs.isError && <Alert color="red">{dirs.error.message}</Alert>}
        {dirs.data && (
          <Stack gap={0} mah={280} style={{ overflowY: "auto" }}>
            {dirs.data.parent !== null && (
              <UnstyledButton
                py={4}
                onClick={() => setPath(dirs.data?.parent ?? "")}
              >
                <Text size="sm">.. (up)</Text>
              </UnstyledButton>
            )}
            {dirs.data.dirs.length === 0 && (
              <Text size="sm" c="dimmed">
                No folders here.
              </Text>
            )}
            {dirs.data.dirs.map((d) => (
              <UnstyledButton
                key={d}
                py={4}
                onClick={() => setPath(`${here.replace(/\/$/, "")}/${d}`)}
              >
                <Text size="sm">{d}</Text>
              </UnstyledButton>
            ))}
          </Stack>
        )}
        <Group justify="flex-end" gap="xs">
          <Button size="xs" variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="xs"
            disabled={!dirs.data}
            onClick={() => {
              onPick(here);
              onClose();
            }}
          >
            Use this folder
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function WorkspaceForm({
  workspace,
  onDone,
  onCancel,
}: {
  workspace: Workspace | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<WorkspaceInput>({
    name: workspace?.name ?? "",
    path: workspace?.path ?? "",
    writable: workspace?.writable ?? false,
  });
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: WorkspaceInput) =>
      workspace
        ? api.saveWorkspace(workspace.id, input)
        : api.createWorkspace(input),
    onSuccess: onDone,
    onError: (err: Error) => setProblem(err.message),
  });
  return (
    <Paper withBorder p="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          save.mutate(v);
        }}
      >
        <Stack gap="xs">
          <Text fw={500}>
            {workspace ? `Edit ${workspace.name}` : "New workspace"}
          </Text>
          <TextInput
            label="Name"
            required
            value={v.name}
            onChange={(e) => setV({ ...v, name: e.currentTarget.value })}
          />
          <Group align="flex-end" gap="xs" wrap="nowrap">
            <TextInput
              label="Folder"
              description="The full path of a folder on this computer."
              required
              style={{ flex: 1 }}
              value={v.path}
              onChange={(e) => setV({ ...v, path: e.currentTarget.value })}
            />
            <Button
              size="xs"
              variant="default"
              onClick={() => setPicking(true)}
            >
              Browse
            </Button>
          </Group>
          <Switch
            label="Writable"
            description="Agents can create, change, move and delete files here, each change asking for your approval. Off: read-only. A project or session can still attach it read-only."
            checked={v.writable}
            onChange={(e) => setV({ ...v, writable: e.currentTarget.checked })}
          />
          {problem && <Alert color="red">{problem}</Alert>}
          <Group gap="xs">
            <Button type="submit" size="xs" loading={save.isPending}>
              Save
            </Button>
            <Button size="xs" variant="default" onClick={onCancel}>
              Cancel
            </Button>
          </Group>
        </Stack>
      </form>
      {/* Mounted when opened, so it starts at what is typed now. */}
      {picking && (
        <FolderPicker
          opened
          start={v.path}
          onPick={(path) => setV({ ...v, path })}
          onClose={() => setPicking(false)}
        />
      )}
    </Paper>
  );
}

/** One folder of the tree of searched parts, loaded when it is opened. */
function TreeFolder({
  workspaceId,
  path,
}: {
  workspaceId: string;
  path: string;
}) {
  const queryClient = useQueryClient();
  const tree = useQuery({
    queryKey: workspaceKeys.tree(workspaceId, path),
    queryFn: () => api.getWorkspaceTree(workspaceId, path),
  });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = useMutation({
    mutationFn: (v: { path: string; on: boolean }) =>
      api.toggleWorkspaceTick(workspaceId, v.path, v.on),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all }),
    onError: failed("Could not change what is searched"),
  });
  if (tree.isPending) return <Loader size="xs" />;
  if (tree.isError) return <Alert color="red">{tree.error.message}</Alert>;
  if (tree.data.entries.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        Empty.
      </Text>
    );
  }
  const row = (e: WorkspaceTreeEntry) => (
    <div key={e.path}>
      <Group gap="xs" wrap="nowrap">
        <Checkbox
          size="xs"
          label={e.kind === "folder" ? `${e.name}/` : e.name}
          checked={e.state === "all"}
          indeterminate={e.state === "some"}
          disabled={toggle.isPending}
          onChange={() =>
            toggle.mutate({ path: e.path, on: e.state !== "all" })
          }
        />
        {e.kind === "folder" && (
          <Button
            size="compact-xs"
            variant="subtle"
            aria-label={`${open[e.path] ? "Close" : "Open"} ${e.name}`}
            onClick={() => setOpen({ ...open, [e.path]: !open[e.path] })}
          >
            {open[e.path] ? "Close" : "Open"}
          </Button>
        )}
      </Group>
      {e.kind === "folder" && open[e.path] && (
        <Stack gap={2} ml="md" mt={2}>
          <TreeFolder workspaceId={workspaceId} path={e.path} />
        </Stack>
      )}
    </div>
  );
  return <Stack gap={2}>{tree.data.entries.map(row)}</Stack>;
}

/**
 * What agents can search in a workspace (files unification design, D45): the
 * user ticks folders and files; a new file in a ticked folder is included.
 */
function SearchedParts({ workspace }: { workspace: Workspace }) {
  const queryClient = useQueryClient();
  const [shown, setShown] = useState(false);
  const index = useQuery({
    queryKey: workspaceKeys.index(workspace.id),
    queryFn: () => api.getWorkspaceIndex(workspace.id),
    enabled: shown,
    // A scan runs in the background after a change.
    refetchInterval: (q) => (q.state.data?.status?.scanning ? 1000 : false),
  });
  const all = useMutation({
    mutationFn: (on: boolean) => api.toggleWorkspaceTick(workspace.id, "", on),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all }),
    onError: failed("Could not change what is searched"),
  });
  const rescan = useMutation({
    mutationFn: () => api.rescanWorkspace(workspace.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all }),
    onError: failed("Could not rescan"),
  });
  const status = index.data?.status;
  return (
    <Stack gap="xs" mt="xs">
      <Group gap="xs">
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => setShown(!shown)}
        >
          {shown ? "Hide searched parts" : "Searched parts"}
        </Button>
        {!shown && workspace.ticks.length > 0 && (
          <Text size="xs" c="dimmed">
            {workspace.ticks.length === 1 && workspace.ticks[0] === ""
              ? "everything"
              : `${workspace.ticks.length} chosen`}
          </Text>
        )}
      </Group>
      {shown && (
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            Tick what agents can search with <code>workspace_search</code>, by
            keywords and by meaning. A new file in a ticked folder is included.
            Everything else can still be listed and read.
          </Text>
          <Checkbox
            size="xs"
            label="The whole folder"
            checked={workspace.ticks.includes("")}
            disabled={all.isPending}
            onChange={(e) => all.mutate(e.currentTarget.checked)}
          />
          <TreeFolder workspaceId={workspace.id} path="" />
          {status && (
            <Group gap="xs">
              <Text size="xs" c="dimmed">
                {status.scanning
                  ? "Scanning…"
                  : status.unavailable
                    ? "The folder is not there; the index is kept as it was."
                    : `${status.files} ${status.files === 1 ? "file" : "files"} searchable.`}
                {status.truncated &&
                  " Too many files are ticked; some are left out."}
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                loading={rescan.isPending}
                onClick={() => rescan.mutate()}
              >
                Rescan
              </Button>
            </Group>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/** What the user said "Always allow" to, per tool and workspace. */
function Grants() {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: workspaceKeys.grants(),
    queryFn: api.listWorkspaceGrants,
  });
  const revoke = useMutation({
    mutationFn: (g: { tool: string; workspaceId: string }) =>
      api.revokeWorkspaceGrant(g.tool, g.workspaceId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all }),
    onError: failed("Could not remove"),
  });
  if (!grants.data || grants.data.length === 0) return null;
  return (
    <Stack gap="xs">
      <Title order={4}>Always allowed</Title>
      <Text size="xs" c="dimmed">
        Tools you chose to always allow for one workspace. Remove one to be
        asked again.
      </Text>
      {grants.data.map((g) => (
        <Group key={`${g.tool}/${g.workspaceId}`} justify="space-between">
          <Text size="sm">
            <code>{g.tool}</code> in {g.workspaceName ?? g.workspaceId}
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            onClick={() => revoke.mutate(g)}
          >
            Remove
          </Button>
        </Group>
      ))}
    </Stack>
  );
}

export function WorkspacesPage() {
  const queryClient = useQueryClient();
  const [showDeleted, setShowDeleted] = useState(false);
  const list = useQuery({
    queryKey: workspaceKeys.list(showDeleted),
    queryFn: () => api.listWorkspaces(showDeleted),
  });
  const [editing, setEditing] = useState<Workspace | "new" | null>(null);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
  const trash = useMutation({
    mutationFn: (w: Workspace) => api.trashWorkspace(w.id),
    onSuccess: refresh,
    onError: failed("Could not move to the trash"),
  });
  const restore = useMutation({
    mutationFn: (w: Workspace) => api.restoreWorkspace(w.id),
    onSuccess: refresh,
    onError: failed("Could not restore"),
  });

  return (
    <Stack maw={720} gap="md">
      <Group justify="space-between">
        <Title order={3}>Workspaces</Title>
        {editing === null && !showDeleted && (
          <Button size="xs" onClick={() => setEditing("new")}>
            New workspace
          </Button>
        )}
      </Group>
      <Text size="sm" c="dimmed">
        Folders on this computer your agents can read, and change when you allow
        it. Attach a workspace to a project or to one session. Moving a
        workspace to the trash does not touch the folder.
      </Text>
      <Checkbox
        size="xs"
        label="Show the trash"
        checked={showDeleted}
        onChange={(e) => setShowDeleted(e.currentTarget.checked)}
      />
      {list.isPending && <Loader size="sm" />}
      {list.isError && <Alert color="red">{list.error.message}</Alert>}
      {list.data?.length === 0 && editing === null && (
        <Text size="sm" c="dimmed">
          {showDeleted ? "The trash is empty." : "No workspaces."}
        </Text>
      )}
      {list.data?.map((w) =>
        editing !== "new" && editing?.id === w.id ? null : (
          <Paper key={w.id} withBorder p="sm">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Group gap="xs">
                  <Text fw={500}>{w.name}</Text>
                  <Badge
                    size="sm"
                    variant="light"
                    color={w.writable ? "orange" : "gray"}
                  >
                    {w.writable ? "writable" : "read-only"}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
                  {w.path}
                </Text>
              </Stack>
              <Group gap="xs" wrap="nowrap">
                {w.deleted ? (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => restore.mutate(w)}
                  >
                    Restore
                  </Button>
                ) : (
                  <>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() => setEditing(w)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={() => trash.mutate(w)}
                    >
                      Move to trash
                    </Button>
                  </>
                )}
              </Group>
            </Group>
            {!w.deleted && <SearchedParts workspace={w} />}
          </Paper>
        ),
      )}
      {editing !== null && (
        <WorkspaceForm
          workspace={editing === "new" ? null : editing}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      <Grants />
    </Stack>
  );
}

/**
 * The workspaces a project or a session has attached, with a way to attach
 * another. A session also shows its project's, which it cannot detach.
 */
export function AttachedWorkspaces({
  owner,
  id,
  disabled = false,
}: {
  owner: WorkspaceOwner;
  id: string;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const attached = useQuery({
    queryKey: workspaceKeys.attached(owner, id),
    queryFn: () => api.listAttachedWorkspaces(owner, id),
  });
  const all = useQuery({
    queryKey: workspaceKeys.list(false),
    queryFn: () => api.listWorkspaces(false),
  });
  const [pick, setPick] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
  const attach = useMutation({
    mutationFn: (v: { workspaceId: string; readOnly: boolean }) =>
      api.attachWorkspace(owner, id, v.workspaceId, v.readOnly),
    onSuccess: () => {
      setPick(null);
      refresh();
    },
    onError: failed("Could not attach"),
  });
  const detach = useMutation({
    mutationFn: (workspaceId: string) =>
      api.detachWorkspace(owner, id, workspaceId),
    onSuccess: refresh,
    onError: failed("Could not detach"),
  });
  const own = (a: WorkspaceAttachment) =>
    a.from === (owner === "projects" ? "project" : "session");
  const taken = new Set(
    (attached.data ?? []).filter(own).map((a) => a.workspace.id),
  );
  const choices = (all.data ?? [])
    .filter((w) => !taken.has(w.id))
    .map((w) => ({ value: w.id, label: w.name }));
  return (
    <Stack gap="xs">
      <Title order={5}>Workspaces</Title>
      {attached.isPending && <Loader size="xs" />}
      {attached.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          None attached.
        </Text>
      )}
      {attached.data?.map((a) => (
        <Group
          key={`${a.from}/${a.workspace.id}`}
          justify="space-between"
          wrap="nowrap"
        >
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm">
              {a.workspace.name}{" "}
              <Badge
                size="xs"
                variant="light"
                color={a.effectiveWritable ? "orange" : "gray"}
              >
                {a.effectiveWritable ? "writable" : "read-only"}
              </Badge>
              {a.from !== (owner === "projects" ? "project" : "session") && (
                <Text span size="xs" c="dimmed">
                  {" "}
                  from the project
                </Text>
              )}
            </Text>
          </Stack>
          {own(a) && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              disabled={disabled}
              onClick={() => detach.mutate(a.workspace.id)}
            >
              Detach
            </Button>
          )}
        </Group>
      ))}
      {!disabled && choices.length > 0 && (
        <Group align="flex-end" gap="xs">
          <Select
            size="xs"
            aria-label="Workspace to attach"
            placeholder="Attach a workspace"
            data={choices}
            value={pick}
            onChange={setPick}
          />
          <Checkbox
            size="xs"
            label="Read-only here"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.currentTarget.checked)}
          />
          <Button
            size="xs"
            disabled={pick === null}
            loading={attach.isPending}
            onClick={() =>
              pick !== null && attach.mutate({ workspaceId: pick, readOnly })
            }
          >
            Attach
          </Button>
        </Group>
      )}
    </Stack>
  );
}

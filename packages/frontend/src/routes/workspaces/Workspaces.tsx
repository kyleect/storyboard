import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { showError } from "../../lib/notify";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  api,
  type Workspace,
  type WorkspaceTreeEntry,
  type WorkspaceInput,
} from "../../api";
import { workspaceKeys } from "../../queries";

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
    onError: showError("Could not change what is searched"),
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

function SearchedParts({ workspace }: { workspace: Workspace }) {
  const queryClient = useQueryClient();
  const [shown, setShown] = useState(false);
  const index = useQuery({
    queryKey: workspaceKeys.index(workspace.id),
    queryFn: () => api.getWorkspaceIndex(workspace.id),
    enabled: shown,
    refetchInterval: (q) => (q.state.data?.status?.scanning ? 1000 : false),
  });
  const all = useMutation({
    mutationFn: (on: boolean) => api.toggleWorkspaceTick(workspace.id, "", on),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all }),
    onError: showError("Could not change what is searched"),
  });
  const rescan = useMutation({
    mutationFn: () => api.rescanWorkspace(workspace.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all }),
    onError: showError("Could not rescan"),
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
    onError: showError("Could not remove"),
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
    onError: showError("Could not move to the trash"),
  });
  const restore = useMutation({
    mutationFn: (w: Workspace) => api.restoreWorkspace(w.id),
    onSuccess: refresh,
    onError: showError("Could not restore"),
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

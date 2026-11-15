import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import utils from "../../styles/utilities.module.css";
import { showError } from "../../lib/notify";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  api,
  type FileScope,
  type Workspace,
  type WorkspaceTreeEntry,
  type WorkspaceInput,
} from "../../api";
import { workspaceKeys } from "../../queries";
import { SCOPE_WORDS } from "../../lib/workspace-source";

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
        <Text size="sm" ff="monospace" className={utils.breakAll}>
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
  scope,
  onDone,
  onCancel,
}: {
  workspace: Workspace | null;
  scope: FileScope;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<WorkspaceInput>({
    name: workspace?.name ?? "",
    path: workspace?.path ?? "",
    writable: workspace?.writable ?? false,
    respectGitignore: workspace?.respectGitignore ?? true,
  });
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: WorkspaceInput) =>
      workspace
        ? api.saveWorkspace(workspace.id, input)
        : api.createWorkspace(scope, input),
    onSuccess: onDone,
    onError: (err: Error) => setProblem(err.message),
  });
  const fixedFolder = workspace?.temporary === true;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setProblem(null);
        save.mutate(v);
      }}
    >
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          Seen by {SCOPE_WORDS[workspace?.scope ?? scope.scope]}.
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
            description={
              fixedFolder
                ? "The app made this folder. It is deleted with the session."
                : "The full path of a folder on this computer."
            }
            required
            flex={1}
            disabled={fixedFolder}
            value={v.path}
            onChange={(e) => setV({ ...v, path: e.currentTarget.value })}
          />
          {!fixedFolder && (
            <Button
              size="xs"
              variant="default"
              onClick={() => setPicking(true)}
            >
              Browse
            </Button>
          )}
        </Group>
        <Switch
          label="Writable"
          description="Agents can create, change, move and delete files here, each change asking for your approval. Off: read-only."
          checked={v.writable}
          onChange={(e) => setV({ ...v, writable: e.currentTarget.checked })}
        />
        <Switch
          label="Respect .gitignore"
          description="Files that its .gitignore files ignore, and the .git folder, are not searched and are not shown to helpers. Turn it off to treat them like any other file."
          checked={v.respectGitignore ?? true}
          onChange={(e) =>
            setV({ ...v, respectGitignore: e.currentTarget.checked })
          }
        />
        {problem && <Alert color="red">{problem}</Alert>}
        <Group gap="xs">
          <Button type="submit" size="xs" loading={save.isPending}>
            Save
          </Button>
          <Button size="xs" variant="default" onClick={onCancel}>
            {workspace ? "Close" : "Cancel"}
          </Button>
        </Group>
      </Stack>
      {picking && (
        <FolderPicker
          opened
          start={v.path}
          onPick={(path) => setV({ ...v, path })}
          onClose={() => setPicking(false)}
        />
      )}
    </form>
  );
}

function TemporaryForm({
  sessionId,
  onDone,
  onCancel,
}: {
  sessionId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createTemporaryWorkspace(sessionId, name),
    onSuccess: onDone,
    onError: (err: Error) => setProblem(err.message),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setProblem(null);
        create.mutate();
      }}
    >
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          An empty folder the app makes for this session. Agents can write in
          it, each change asking for your approval. It is deleted with the
          session.
        </Text>
        <TextInput
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        {problem && <Alert color="red">{problem}</Alert>}
        <Group gap="xs">
          <Button type="submit" size="xs" loading={create.isPending}>
            Create
          </Button>
          <Button size="xs" variant="default" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function TreeFolder({
  workspaceId,
  path,
  scope,
}: {
  workspaceId: string;
  path: string;
  scope: FileScope;
}) {
  const queryClient = useQueryClient();
  const tree = useQuery({
    queryKey: workspaceKeys.tree(workspaceId, path, scope),
    queryFn: () => api.getWorkspaceTree(workspaceId, path, scope),
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
          // Not visible here, or ignored: not searched, and not tickable.
          checked={e.state === "all" && e.hidden !== "all" && !e.ignored}
          indeterminate={e.state === "some" && e.hidden !== "all"}
          disabled={
            toggle.isPending || e.hidden === "all" || e.ignored === true
          }
          onChange={() =>
            toggle.mutate({ path: e.path, on: e.state !== "all" })
          }
        />
        {e.ignored && (
          <Text size="xs" c="dimmed">
            ignored
          </Text>
        )}
        {e.hidden === "all" && (
          <Text size="xs" c="dimmed">
            hidden here
          </Text>
        )}
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
          <TreeFolder workspaceId={workspaceId} path={e.path} scope={scope} />
        </Stack>
      )}
    </div>
  );

  return <Stack gap={2}>{tree.data.entries.map(row)}</Stack>;
}

function SearchedParts({
  workspace,
  scope,
}: {
  workspace: Workspace;
  scope: FileScope;
}) {
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
          <TreeFolder workspaceId={workspace.id} path="" scope={scope} />
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

function Grants({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: workspaceKeys.grants(),
    queryFn: api.listWorkspaceGrants,
  });
  const revoke = useMutation({
    mutationFn: (tool: string) => api.revokeWorkspaceGrant(tool, workspaceId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all }),
    onError: showError("Could not remove"),
  });
  const mine = (grants.data ?? []).filter((g) => g.workspaceId === workspaceId);

  if (mine.length === 0) return null;

  return (
    <Stack gap="xs">
      <Title order={5}>Always allowed</Title>
      <Text size="xs" c="dimmed">
        Tools you chose to always allow in this workspace. Remove one to be
        asked again.
      </Text>
      {mine.map((g) => (
        <Group key={g.tool} justify="space-between">
          <Text size="sm">
            <code>{g.tool}</code>
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            onClick={() => revoke.mutate(g.tool)}
          >
            Remove
          </Button>
        </Group>
      ))}
    </Stack>
  );
}

function Listing({ workspace }: { workspace: Workspace }) {
  const listing = useQuery({
    queryKey: [...workspaceKeys.contents(workspace.id), "summary"],
    queryFn: () => api.listWorkspaceFiles(workspace.id),
  });

  if (listing.data?.unavailable) {
    return (
      <Alert color="yellow" p="xs">
        The folder is not there right now.
      </Alert>
    );
  }

  if (listing.data?.truncated) {
    return (
      <Alert color="yellow" p="xs">
        The folder is large. The Files tree shows the first{" "}
        {listing.data.entries.length} entries, the shallowest first.
      </Alert>
    );
  }

  return null;
}

/** A workspace's own tab in the Files tree: its settings, what is searched and what is always allowed. */
export function WorkspaceSettings({
  workspace,
  scope,
  onClose,
}: {
  workspace: Workspace;
  /** The page the tab is in: what it hides is not searched there. */
  scope: FileScope;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  return (
    <ScrollArea h="100%">
      <Stack maw={720} gap="md" p="md">
        <Title order={4}>{workspace.name}</Title>
        <Listing workspace={workspace} />
        <WorkspaceForm
          key={workspace.updatedAt}
          workspace={workspace}
          scope={{ scope: "global" }}
          onDone={() =>
            void queryClient.invalidateQueries({ queryKey: workspaceKeys.all })
          }
          onCancel={onClose}
        />
        <SearchedParts workspace={workspace} scope={scope} />
        <Grants workspaceId={workspace.id} />
      </Stack>
    </ScrollArea>
  );
}

/** The tab for a new workspace, permanent or temporary, at one scope. */
export function NewWorkspace({
  scope,
  temporary,
  onDone,
  onClose,
}: {
  scope: FileScope;
  temporary: boolean;
  onDone: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    onDone();
  };

  return (
    <ScrollArea h="100%">
      <Stack maw={720} gap="md" p="md">
        <Title order={4}>
          {temporary ? "New temporary workspace" : "New workspace"}
        </Title>
        {temporary && scope.scope === "session" ? (
          <TemporaryForm
            sessionId={scope.id}
            onDone={done}
            onCancel={onClose}
          />
        ) : (
          <WorkspaceForm
            workspace={null}
            scope={scope}
            onDone={done}
            onCancel={onClose}
          />
        )}
      </Stack>
    </ScrollArea>
  );
}

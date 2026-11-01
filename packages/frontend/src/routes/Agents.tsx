import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  FileButton,
  Group,
  Loader,
  Modal,
  NavLink,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  agentsKey,
  api,
  ApiError,
  type AgentContent,
  type AgentDetail,
  type AgentScope,
  type AgentVersion,
  type ImportConflict,
  type MessageAgent,
  type PickableAgent,
  type ToolMode,
} from "../api";
import { showError } from "./SessionActions";

/*
 * Agents (agents design, decisions 15 and 30 to 37): a page per scope with
 * the list on the left and the selected agent on the right, as on the files
 * page; the picker in the chat view; and the read-only view of the version
 * a message was written with.
 */

const when = (iso: string) => (iso ? new Date(iso).toLocaleString() : "");

/** Refreshes a scope's lists and open agents after a change. */
function useRefresh(scope: AgentScope) {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: agentsKey(scope) });
    await queryClient.invalidateQueries({ queryKey: ["agents", "one"] });
    await queryClient.invalidateQueries({ queryKey: ["session-agents"] });
  };
}

/** The tools an agent can select, by name. */
function useSelectableTools() {
  return useQuery({ queryKey: ["agent-tools"], queryFn: api.agentTools });
}

function DeletedBadge() {
  return (
    <Badge size="xs" variant="light" color="red">
      deleted
    </Badge>
  );
}

/** Text in a box, keeping line breaks. */
function TextBox({ value }: { value: string }) {
  return (
    <Paper p="sm" withBorder>
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
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

/**
 * The tool selection in words, with tools that no longer exist marked
 * (P6). The files and memory tools are always on.
 */
function ToolsSummary({
  toolMode,
  tools,
  known,
}: {
  toolMode: ToolMode;
  tools: string[];
  known: Set<string> | undefined;
}) {
  const label =
    toolMode === "allow"
      ? tools.length === 0
        ? "No tools besides files and memory."
        : "Only these tools, plus files and memory:"
      : tools.length === 0
        ? "Every tool."
        : "Every tool except:";
  return (
    <Stack gap={4}>
      <Text size="sm">{label}</Text>
      {tools.length > 0 && (
        <Group gap={4}>
          {tools.map((t) => (
            <Badge
              key={t}
              size="sm"
              variant="light"
              color={known && !known.has(t) ? "red" : "gray"}
              tt="none"
            >
              {t}
              {known && !known.has(t) ? " (missing)" : ""}
            </Badge>
          ))}
        </Group>
      )}
    </Stack>
  );
}

/** One version's content, read-only. */
function VersionContent({
  v,
  known,
}: {
  v: AgentContent;
  known: Set<string> | undefined;
}) {
  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        {v.name}
      </Text>
      {v.description && (
        <Text size="sm" c="dimmed">
          {v.description}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        System prompt
      </Text>
      <TextBox value={v.prompt} />
      <Text size="xs" c="dimmed">
        Tools
      </Text>
      <ToolsSummary toolMode={v.toolMode} tools={v.tools} known={known} />
    </Stack>
  );
}

/** An agent's versions; one can be made current (decision 21). */
function VersionsModal({
  scope,
  agent,
  readOnly,
  onClose,
}: {
  scope: AgentScope;
  agent: AgentDetail;
  readOnly: boolean;
  onClose: () => void;
}) {
  const refresh = useRefresh(scope);
  const tools = useSelectableTools();
  const known = tools.data ? new Set(tools.data.map((t) => t.name)) : undefined;
  const newestFirst = [...agent.versions].reverse();
  const [picked, setPicked] = useState<AgentVersion | undefined>(
    newestFirst[0],
  );
  const restore = useMutation({
    mutationFn: (seq: number) => api.restoreAgent(agent.id, seq),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: showError("Could not restore the version"),
  });
  const isCurrent = picked?.seq === agent.version && !agent.deleted;

  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={`Versions of ${agent.name}`}
    >
      <Group align="flex-start" wrap="nowrap" gap="md">
        <ScrollArea.Autosize mah="60vh" w={220} style={{ flexShrink: 0 }}>
          {newestFirst.map((v) => (
            <NavLink
              key={v.seq}
              active={picked?.seq === v.seq}
              onClick={() => setPicked(v)}
              label={
                <Group gap={4}>
                  <Text size="sm">v{v.seq}</Text>
                  {v.deleted && <DeletedBadge />}
                </Group>
              }
              description={when(v.createdAt)}
            />
          ))}
        </ScrollArea.Autosize>
        {picked && (
          <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                {picked.deleted
                  ? "Deleted here; the content it had is shown."
                  : ""}
              </Text>
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
              <VersionContent v={picked} known={known} />
            </ScrollArea.Autosize>
          </Stack>
        )}
      </Group>
    </Modal>
  );
}

/** Downloads text as a file. */
function download(filename: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/markdown;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** The name with characters file systems refuse replaced by "_". */
const fileName = (name: string) =>
  `${[...name]
    .map((c) => (c < " " || '\\/:*?"<>|'.includes(c) ? "_" : c))
    .join("")}.md`;

type Mode = { mode: "view" } | { mode: "edit" } | { mode: "new" };

/**
 * A scope's agents: list on the left, the selected agent on the right.
 * `readOnly` with a reason when changes are not allowed.
 */
export function AgentsPanel({
  scope,
  readOnly,
}: {
  scope: AgentScope;
  readOnly?: string | undefined;
}) {
  const refresh = useRefresh(scope);
  const [showDeleted, setShowDeleted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ mode: "view" });
  const list = useQuery({
    queryKey: [...agentsKey(scope), "list", showDeleted],
    queryFn: () => api.listAgents(scope, showDeleted),
  });

  const importFile = useMutation({
    mutationFn: async (a: { markdown: string; replace: boolean }) =>
      api.importAgent(scope, a.markdown, a.replace),
    onSuccess: async (result) => {
      await refresh();
      setSelected(result.agent.id);
      setMode({ mode: "view" });
      for (const warning of result.warnings) {
        notifications.show({
          color: "yellow",
          title: "Imported with changes",
          message: warning,
        });
      }
    },
    onError: (err: Error, a) => {
      const conflict =
        err instanceof ApiError && err.status === 409
          ? (err.body as { conflict?: ImportConflict } | undefined)?.conflict
          : undefined;
      if (!conflict) {
        showError("Could not import the agent")(err);
        return;
      }
      // Ask each time (decision 28).
      modals.openConfirmModal({
        title: "An agent with this name exists",
        children: (
          <Text size="sm">
            {err.message} Replace it? The file becomes its next version
            {conflict.deleted ? ", and the deleted agent is restored" : ""};
            earlier versions are kept.
          </Text>
        ),
        labels: { confirm: "Replace", cancel: "Cancel" },
        onConfirm: () =>
          importFile.mutate({ markdown: a.markdown, replace: true }),
      });
    },
  });

  return (
    <Group align="flex-start" wrap="nowrap" gap="md" h="100%">
      <Stack gap="xs" w={260} style={{ flexShrink: 0 }}>
        {readOnly && (
          <Text size="sm" c="dimmed">
            {readOnly}
          </Text>
        )}
        <Switch
          size="xs"
          label="Show deleted"
          checked={showDeleted}
          onChange={(e) => setShowDeleted(e.currentTarget.checked)}
        />
        {!readOnly && (
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              onClick={() => {
                setSelected(null);
                setMode({ mode: "new" });
              }}
            >
              New agent
            </Button>
            <FileButton
              accept=".md,text/markdown,text/plain"
              onChange={(file) => {
                if (!file) return;
                void file
                  .text()
                  .then((markdown) =>
                    importFile.mutate({ markdown, replace: false }),
                  );
              }}
            >
              {(props) => (
                <Button
                  {...props}
                  size="xs"
                  variant="default"
                  loading={importFile.isPending}
                >
                  Import
                </Button>
              )}
            </FileButton>
          </Group>
        )}
        {list.isPending && <Loader size="sm" />}
        {list.isError && <Alert color="red">{list.error.message}</Alert>}
        {list.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            No agents.
          </Text>
        )}
        <Stack gap={0}>
          {list.data?.map((a) => (
            <NavLink
              key={a.id}
              active={selected === a.id && mode.mode !== "new"}
              onClick={() => {
                setSelected(a.id);
                setMode({ mode: "view" });
              }}
              label={
                <Text
                  size="sm"
                  {...(a.deleted ? { c: "dimmed" } : {})}
                  truncate
                >
                  {a.name}
                </Text>
              }
              description={a.description || when(a.updatedAt)}
              rightSection={a.deleted ? <DeletedBadge /> : undefined}
            />
          ))}
        </Stack>
      </Stack>
      <Stack style={{ flex: 1, minWidth: 0 }}>
        {mode.mode === "new" && !readOnly ? (
          <AgentEditor
            scope={scope}
            onSaved={(id) => {
              setSelected(id);
              setMode({ mode: "view" });
            }}
            onCancel={() => setMode({ mode: "view" })}
          />
        ) : selected ? (
          <AgentView
            key={selected}
            scope={scope}
            agentId={selected}
            readOnly={!!readOnly}
            editing={mode.mode === "edit"}
            onEdit={() => setMode({ mode: "edit" })}
            onDone={() => setMode({ mode: "view" })}
            onGone={() => setSelected(null)}
          />
        ) : (
          <Text size="sm" c="dimmed">
            Pick an agent on the left.
          </Text>
        )}
      </Stack>
    </Group>
  );
}

function AgentView({
  scope,
  agentId,
  readOnly,
  editing,
  onEdit,
  onDone,
  onGone,
}: {
  scope: AgentScope;
  agentId: string;
  readOnly: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onGone: () => void;
}) {
  const refresh = useRefresh(scope);
  const tools = useSelectableTools();
  const known = tools.data ? new Set(tools.data.map((t) => t.name)) : undefined;
  const [versions, setVersions] = useState(false);
  const agent = useQuery({
    queryKey: ["agents", "one", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAgent(agentId),
    onSuccess: refresh,
    onError: showError("Could not delete the agent"),
  });
  const exportFile = useMutation({
    mutationFn: () => api.exportAgent(agentId),
    onSuccess: (text) => {
      if (agent.data) download(fileName(agent.data.name), text);
    },
    onError: showError("Could not export the agent"),
  });

  if (agent.isPending) return <Loader size="sm" />;
  if (agent.isError) {
    return (
      <Alert color="red" withCloseButton onClose={onGone}>
        {agent.error.message}
      </Alert>
    );
  }
  const a = agent.data;

  if (editing && !readOnly && !a.deleted) {
    return (
      <AgentEditor
        scope={scope}
        existing={a}
        onSaved={onDone}
        onCancel={onDone}
      />
    );
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Title order={5} style={{ wordBreak: "break-word" }}>
            {a.name}
          </Title>
          <Badge size="xs" variant="light" color="gray">
            v{a.version}
          </Badge>
          {a.deleted && <DeletedBadge />}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="default" onClick={() => setVersions(true)}>
            Versions ({a.versions.length})
          </Button>
          <Button
            size="xs"
            variant="default"
            loading={exportFile.isPending}
            onClick={() => exportFile.mutate()}
          >
            Export
          </Button>
          {!readOnly && !a.deleted && (
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
                  modals.openConfirmModal({
                    title: `Delete “${a.name}”?`,
                    children: (
                      <Text size="sm">
                        Sessions using it go back to no agent. Its versions are
                        kept, and it can be restored from them.
                      </Text>
                    ),
                    labels: { confirm: "Delete", cancel: "Cancel" },
                    confirmProps: { color: "red" },
                    onConfirm: () => remove.mutate(),
                  })
                }
              >
                Delete
              </Button>
            </>
          )}
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        {a.deleted ? "Deleted" : "Changed"} {when(a.updatedAt)}
        {a.deleted && ". Open Versions to restore it."}
      </Text>
      {a.description && <Text size="sm">{a.description}</Text>}
      <Text size="xs" c="dimmed">
        System prompt
      </Text>
      <TextBox value={a.prompt} />
      <Text size="xs" c="dimmed">
        Tools
      </Text>
      <ToolsSummary toolMode={a.toolMode} tools={a.tools} known={known} />
      {versions && (
        <VersionsModal
          scope={scope}
          agent={a}
          readOnly={readOnly}
          onClose={() => setVersions(false)}
        />
      )}
    </Stack>
  );
}

/** Creates an agent, or saves `existing` as a new version. */
function AgentEditor({
  scope,
  existing,
  onSaved,
  onCancel,
}: {
  scope: AgentScope;
  existing?: AgentDetail;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const refresh = useRefresh(scope);
  const tools = useSelectableTools();
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  // A new agent starts as an allow list with nothing ticked (P8).
  const [toolMode, setToolMode] = useState<ToolMode>(
    existing?.toolMode ?? "allow",
  );
  const [picked, setPicked] = useState<string[]>(existing?.tools ?? []);
  const known = new Set(tools.data?.map((t) => t.name) ?? []);
  // Stored names with no such tool, shown so they can be removed (P6).
  const missing = tools.data ? picked.filter((t) => !known.has(t)) : [];

  const save = useMutation({
    mutationFn: () => {
      const c: AgentContent = {
        name,
        description,
        prompt,
        toolMode,
        tools: picked,
      };
      return existing
        ? api.saveAgent(existing.id, c)
        : api.createAgent(scope, c);
    },
    onSuccess: async (saved) => {
      await refresh();
      onSaved(saved.id);
    },
    onError: showError("Could not save the agent"),
  });

  return (
    <Stack gap="xs">
      <TextInput
        label="Name"
        description="Unique among this scope's agents. Case-sensitive."
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <TextInput
        label="Description"
        description="Optional."
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Textarea
        label="System prompt"
        autosize
        minRows={8}
        maxRows={30}
        value={prompt}
        onChange={(e) => setPrompt(e.currentTarget.value)}
      />
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Tools
        </Text>
        <Text size="xs" c="dimmed">
          The files and memory tools are always on.
        </Text>
        <SegmentedControl
          size="xs"
          w="fit-content"
          value={toolMode}
          onChange={(v) => setToolMode(v as ToolMode)}
          data={[
            { value: "allow", label: "Only the ticked tools" },
            { value: "deny", label: "Every tool except the ticked ones" },
          ]}
        />
        {tools.isPending && <Loader size="xs" />}
        {tools.isError && <Alert color="red">{tools.error.message}</Alert>}
        <Checkbox.Group value={picked} onChange={setPicked}>
          <Stack gap={6} mt={4}>
            {tools.data?.map((t) => (
              <Checkbox
                key={t.name}
                value={t.name}
                label={t.name}
                description={t.description}
              />
            ))}
            {missing.map((t) => (
              <Checkbox
                key={t}
                value={t}
                color="red"
                label={`${t} (missing)`}
                description="No tool has this name any more. Untick it to remove it."
              />
            ))}
          </Stack>
        </Checkbox.Group>
      </Stack>
      <Group gap="xs">
        <Button
          size="xs"
          disabled={name.trim() === ""}
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

/** Global agents (decision 30). */
export function GlobalAgentsPage() {
  return (
    <Stack gap="md">
      <Title order={3}>Agents</Title>
      <Text size="sm" c="dimmed">
        Global: every session can use these.
      </Text>
      <AgentsPanel scope={{ scope: "global" }} />
    </Stack>
  );
}

/** A project's agents (decision 31). */
export function ProjectAgentsPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/agents" });
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
      <Title order={3}>Agents</Title>
      <Text size="sm" c="dimmed">
        Project{" "}
        <Anchor
          renderRoot={(props) => (
            <Link {...props} to="/projects/$projectId" params={{ projectId }} />
          )}
        >
          {project.data.name}
        </Anchor>
        : sessions in this project can use these, as well as the global ones.
      </Text>
      <AgentsPanel
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

const NO_AGENT = "";

/**
 * The session's agent (decisions 10, 17, 32): no agent, then the project's
 * agents, then the global ones, labelled by scope.
 */
export function AgentPicker({
  sessionId,
  value,
  onChange,
  disabled,
}: {
  sessionId: string;
  value: string | null;
  onChange: (agentId: string | null) => void;
  disabled?: boolean;
}) {
  const agents = useQuery({
    queryKey: ["session-agents", sessionId],
    queryFn: () => api.sessionAgents(sessionId),
  });
  const group = (scope: PickableAgent["scope"], label: string) => {
    const items = (agents.data ?? [])
      .filter((a) => a.scope === scope)
      .map((a) => ({ value: a.id, label: `${a.name} (${scope})` }));
    return items.length > 0 ? [{ group: label, items }] : [];
  };
  return (
    <Select
      w={220}
      aria-label="Agent"
      allowDeselect={false}
      searchable
      disabled={!!disabled}
      value={value ?? NO_AGENT}
      onChange={(v) => onChange(v === NO_AGENT || v === null ? null : v)}
      data={[
        { group: "", items: [{ value: NO_AGENT, label: "No agent" }] },
        ...group("project", "Project agents"),
        ...group("global", "Global agents"),
      ]}
      {...(agents.isError ? { error: agents.error.message } : {})}
      {...(agents.isPending ? { rightSection: <Loader size="xs" /> } : {})}
    />
  );
}

/**
 * The agent label on an assistant message, "Name v3" (decision 15). Clicking
 * it shows that version.
 */
export function AgentBadge({ agent }: { agent: MessageAgent }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Badge
        size="xs"
        variant="light"
        color="teal"
        tt="none"
        style={{ cursor: "pointer" }}
        onClick={() => setOpen(true)}
        title="Show this version of the agent"
      >
        {agent.name} v{agent.version}
      </Badge>
      {open && (
        <AgentVersionModal agent={agent} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function AgentVersionModal({
  agent,
  onClose,
}: {
  agent: MessageAgent;
  onClose: () => void;
}) {
  const tools = useSelectableTools();
  const known = tools.data ? new Set(tools.data.map((t) => t.name)) : undefined;
  // Versions never change, so this is never refetched.
  const version = useQuery({
    queryKey: ["agent-version", agent.id, agent.version],
    queryFn: () => api.getAgentVersion(agent.id, agent.version),
    staleTime: Infinity,
  });
  return (
    <Modal
      opened
      onClose={onClose}
      size="lg"
      title={`${agent.name} v${agent.version} (${agent.projectId ? "project" : "global"})`}
    >
      {version.isPending && <Loader size="sm" />}
      {version.isError && <Alert color="red">{version.error.message}</Alert>}
      {version.data && <VersionContent v={version.data} known={known} />}
    </Modal>
  );
}

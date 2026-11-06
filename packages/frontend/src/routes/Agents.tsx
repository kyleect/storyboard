import {
  Alert,
  Anchor,
  Badge,
  Button,
  FileButton,
  Group,
  Loader,
  Modal,
  NavLink,
  NumberInput,
  Paper,
  ScrollArea,
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
  type Project,
} from "../api";
import { showError } from "./SessionActions";
import { DataPanel } from "./Data";
import { SchemasPanel } from "./Schemas";
import { SkillsPanel } from "./Skills";
import { ApprovalSelect } from "./ApprovalSelect";
import { ToolGrantEditor } from "./ToolGrantEditor";
import { TOOL_GROUPS } from "@harness/core";
import { emptyGrant, type ToolGrant } from "../tool-grant";

export { ApprovalSelect };

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

/** Every tool with its setting now, for the approval choices. */
function useToolApprovals() {
  return useQuery({
    queryKey: ["agent-tool-approvals"],
    queryFn: api.agentToolApprovals,
  });
}

function DefaultBadge() {
  return (
    <Badge size="xs" variant="light">
      Default
    </Badge>
  );
}

function BuiltinBadge() {
  return (
    <Badge size="xs" variant="light" color="teal">
      built-in
    </Badge>
  );
}

/** What an agent's subagent settings say, for its page. */
function SubagentSummary({ agent }: { agent: AgentContent }) {
  return (
    <Stack gap={2}>
      <Text size="sm">
        {agent.subagent
          ? "Can be started by other agents."
          : "Cannot be started by other agents."}
      </Text>
      <Text size="xs" c="dimmed">
        Reminders:{" "}
        {agent.childReminders === null
          ? "the global setting"
          : agent.childReminders}
        . Line:{" "}
        {agent.childPrompt === null
          ? "the global setting"
          : agent.childPrompt === ""
            ? "none"
            : "its own"}
        .
      </Text>
    </Stack>
  );
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
 * (P6). Tools that are always on are not listed.
 */
function ToolsSummary({
  toolGrant,
  toolApproval,
  known,
}: {
  toolGrant: ToolGrant;
  toolApproval: Record<string, boolean>;
  known: Set<string> | undefined;
}) {
  const approvals = Object.entries(toolApproval);
  const labelOf = (id: string) =>
    TOOL_GROUPS.find((g) => g.id === id)?.label ?? id;
  const allow = toolGrant.mode === "allow";
  const nothing =
    toolGrant.groups.length === 0 &&
    toolGrant.except.length === 0 &&
    toolGrant.extras.length === 0;
  const label = allow
    ? nothing
      ? "Only the tools that are always on."
      : "Only these tools, plus those that are always on:"
    : nothing
      ? "Every tool but those that need review."
      : "Every tool but those that need review, except:";
  const names = (list: string[]) =>
    list.map((t) => (
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
    ));
  return (
    <Stack gap={4}>
      <Text size="sm">{label}</Text>
      {toolGrant.groups.length > 0 && (
        <Group gap={4}>
          <Text size="xs" c="dimmed">
            Groups:
          </Text>
          {toolGrant.groups.map((g) => (
            <Badge key={g} size="sm" variant="light" tt="none">
              {labelOf(g)}
            </Badge>
          ))}
        </Group>
      )}
      {toolGrant.except.length > 0 && (
        <Group gap={4}>
          <Text size="xs" c="dimmed">
            {allow ? "Left out of those groups:" : "Still allowed:"}
          </Text>
          {names(toolGrant.except)}
        </Group>
      )}
      {toolGrant.extras.length > 0 && (
        <Group gap={4}>
          <Text size="xs" c="dimmed">
            Also:
          </Text>
          {names(toolGrant.extras)}
        </Group>
      )}
      {approvals.length > 0 && (
        <>
          <Text size="sm">Approval this agent sets:</Text>
          <Group gap={4}>
            {approvals.map(([t, ask]) => (
              <Badge
                key={t}
                size="sm"
                variant="light"
                color={ask ? "orange" : "teal"}
                tt="none"
              >
                {t}: {ask ? "asks" : "no approval"}
              </Badge>
            ))}
          </Group>
        </>
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
      <ToolsSummary
        toolGrant={v.toolGrant}
        toolApproval={v.toolApproval}
        known={known}
      />
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

type Mode =
  | { mode: "view" }
  | { mode: "edit" }
  | { mode: "new" }
  /** A new agent started from another (a built-in one's Copy). */
  | { mode: "copy"; source: AgentDetail };

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
              active={
                selected === a.id && mode.mode !== "new" && mode.mode !== "copy"
              }
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
              rightSection={
                a.deleted ? (
                  <DeletedBadge />
                ) : a.isDefault || a.builtin || a.newTools.length > 0 ? (
                  <Group gap={4} wrap="nowrap">
                    {a.newTools.length > 0 && (
                      <Badge size="xs" variant="light" color="blue">
                        {a.newTools.length} new
                      </Badge>
                    )}
                    {a.builtin && <BuiltinBadge />}
                    {a.isDefault && <DefaultBadge />}
                  </Group>
                ) : undefined
              }
            />
          ))}
        </Stack>
      </Stack>
      <Stack style={{ flex: 1, minWidth: 0 }}>
        {(mode.mode === "new" || mode.mode === "copy") && !readOnly ? (
          <AgentEditor
            scope={scope}
            {...(mode.mode === "copy" ? { copyOf: mode.source } : {})}
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
            onCopy={(source) => setMode({ mode: "copy", source })}
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
  onCopy,
  onDone,
  onGone,
}: {
  scope: AgentScope;
  agentId: string;
  readOnly: boolean;
  editing: boolean;
  onEdit: () => void;
  onCopy: (source: AgentDetail) => void;
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

  if (editing && !readOnly && !a.deleted && !a.builtin) {
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
          {a.builtin && <BuiltinBadge />}
        </Group>
        <Group gap="xs" wrap="nowrap">
          {!a.builtin && (
            <Button
              size="xs"
              variant="default"
              onClick={() => setVersions(true)}
            >
              Versions ({a.versions.length})
            </Button>
          )}
          <Button
            size="xs"
            variant="default"
            loading={exportFile.isPending}
            onClick={() => exportFile.mutate()}
          >
            Export
          </Button>
          {/* A built-in agent cannot be changed; Copy starts a new agent
              from it (agent delegation design, B8a). */}
          {!readOnly && a.builtin && (
            <Button size="xs" variant="light" onClick={() => onCopy(a)}>
              Copy
            </Button>
          )}
          {!readOnly && !a.deleted && !a.builtin && (
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
        {a.builtin
          ? "Built in. It cannot be changed or deleted; Copy makes an agent of your own from it."
          : `${a.deleted ? "Deleted" : "Changed"} ${when(a.updatedAt)}`}
        {a.deleted && ". Open Versions to restore it."}
      </Text>
      {a.description && <Text size="sm">{a.description}</Text>}
      {a.newTools.length > 0 && !a.deleted && !a.builtin && (
        <Alert color="blue" p="xs" title="New tools">
          {a.newTools.length === 1
            ? "1 tool has been added since this agent was last saved: "
            : `${a.newTools.length} tools have been added since this agent was last saved: `}
          {a.newTools.join(", ")}. Edit and save the agent to count them as
          seen.
        </Alert>
      )}
      <Text size="xs" c="dimmed">
        As a subagent
      </Text>
      <SubagentSummary agent={a} />
      <Text size="xs" c="dimmed">
        System prompt
      </Text>
      <TextBox value={a.prompt} />
      <Text size="xs" c="dimmed">
        Tools
      </Text>
      <ToolsSummary
        toolGrant={a.toolGrant}
        toolApproval={a.toolApproval}
        known={known}
      />
      <Text size="xs" c="dimmed">
        Skills
      </Text>
      <SkillsPanel
        owner={{ scope: "agent", id: a.id }}
        readOnly={
          a.deleted
            ? "The agent is deleted, so its skills can be read but not changed."
            : readOnly
              ? "The project is in the trash, so these can be read but not changed."
              : undefined
        }
      />
      <Text size="xs" c="dimmed">
        Schemas
      </Text>
      <SchemasPanel
        owner={{ scope: "agent", id: a.id }}
        readOnly={
          a.deleted
            ? "The agent is deleted, so its schemas can be read but not changed."
            : readOnly
              ? "The project is in the trash, so these schemas can be read but not changed."
              : undefined
        }
      />
      <Text size="xs" c="dimmed">
        Data
      </Text>
      <DataPanel
        owner={{ scope: "agent", id: a.id }}
        readOnly={
          a.deleted
            ? "The agent is deleted, so its data can be read but not changed."
            : readOnly
              ? "The project is in the trash, so this data can be read but not changed."
              : undefined
        }
      />
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
  copyOf,
  onSaved,
  onCancel,
}: {
  scope: AgentScope;
  existing?: AgentDetail;
  /** Starts a new agent with this one's content (a built-in agent's Copy). */
  copyOf?: AgentDetail;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const refresh = useRefresh(scope);
  const tools = useSelectableTools();
  const approvals = useToolApprovals();
  // What the fields start with: the agent being edited, or the one copied.
  const from = existing ?? copyOf;
  const [name, setName] = useState(
    existing ? existing.name : copyOf ? `${copyOf.name} (copy)` : "",
  );
  const [description, setDescription] = useState(from?.description ?? "");
  const [prompt, setPrompt] = useState(from?.prompt ?? "");
  // A new agent starts as an allow list with nothing ticked (P8).
  const [grant, setGrant] = useState<ToolGrant>(
    from?.toolGrant ?? emptyGrant(),
  );
  // The agent's own approval choices, by tool; a tool not here follows its
  // own setting.
  const [approval, setApproval] = useState<Record<string, boolean>>(
    from?.toolApproval ?? {},
  );
  // As a subagent (agent delegation design, decisions 14 to 17, 20): off
  // unless chosen; reminders and the line follow the global settings unless
  // set here (null: not set).
  const [subagent, setSubagent] = useState(existing?.subagent ?? false);
  const [reminders, setReminders] = useState<number | null>(
    from?.childReminders ?? null,
  );
  const [childLine, setChildLine] = useState<string | null>(
    from?.childPrompt ?? null,
  );
  // Tools added since the agent was last saved (decision 4). A copy of a
  // built-in agent has none.
  const newTools = new Set(existing?.newTools ?? []);

  const save = useMutation({
    mutationFn: () => {
      const c: AgentContent = {
        name,
        description,
        prompt,
        toolGrant: grant,
        toolApproval: approval,
        childReminders: reminders,
        childPrompt: childLine,
        subagent,
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
    <Stack gap="lg">
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
        description="Write {{skills}}, {{tools}}, {{schemas}}, {{data}} or {{agents}} to put the list of skills, tools, schemas, data or agents (the ones it can start) the chat has at that place."
        autosize
        minRows={8}
        maxRows={30}
        value={prompt}
        onChange={(e) => setPrompt(e.currentTarget.value)}
      />

      <Stack gap="xs">
        <Text size="sm" fw={500}>
          As a subagent
        </Text>
        <Switch
          label="Can be started by other agents"
          description="Other agents can hand work to this one with start_subagent. Off unless you turn it on."
          checked={subagent}
          onChange={(e) => setSubagent(e.currentTarget.checked)}
        />
        <Switch
          label="Use the global number of reminders"
          description="How many times it is reminded to hand back when it stops without doing so."
          checked={reminders === null}
          onChange={(e) => setReminders(e.currentTarget.checked ? null : 2)}
        />
        {reminders !== null && (
          <NumberInput
            aria-label="Reminders"
            allowDecimal={false}
            min={0}
            w={120}
            value={reminders}
            onChange={(v) => setReminders(typeof v === "number" ? v : 0)}
          />
        )}
        <Switch
          label="Use the global subagent line"
          description="Added at the end of its system message when it runs as a subagent."
          checked={childLine === null}
          onChange={(e) => setChildLine(e.currentTarget.checked ? null : "")}
        />
        {childLine !== null && (
          <Textarea
            aria-label="Subagent line"
            autosize
            minRows={2}
            value={childLine}
            onChange={(e) => setChildLine(e.currentTarget.value)}
          />
        )}
        {childLine !== null && childLine.trim() === "" && (
          <Alert color="yellow" p="xs">
            Without this line, subagents might not work correctly: they may not
            know to hand back or to ask you with a form.
          </Alert>
        )}
      </Stack>

      <Stack mt="xl">
        <Text size="sm" fw={500}>
          Tools
        </Text>
        <Text size="xs" c="dimmed">
          Tools that are always on are ticked and locked. For each tool or
          group, you can also choose whether this agent asks before a call, or
          follows the tool&apos;s own setting. Saving counts new tools as seen.
        </Text>
        {(tools.isPending || approvals.isPending) && <Loader size="xs" />}
        {tools.isError && <Alert color="red">{tools.error.message}</Alert>}
        {approvals.isError && (
          <Alert color="red">{approvals.error.message}</Alert>
        )}
        {tools.data && approvals.data && (
          <ToolGrantEditor
            grant={grant}
            onGrant={setGrant}
            approval={approval}
            onApproval={setApproval}
            tools={tools.data}
            approvals={approvals.data}
            newTools={newTools}
          />
        )}
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
      <GlobalDefaultAgentSelect />
      <AgentsPanel scope={{ scope: "global" }} />
    </Stack>
  );
}

const NO_DEFAULT = "";

/**
 * The global default agent: new sessions start with it unless their project
 * has a default of its own (global default agent design, decisions 1 to 6).
 * Global agents are offered, or none.
 */
function GlobalDefaultAgentSelect() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });
  const global = useQuery({
    queryKey: [...agentsKey({ scope: "global" }), "list", false],
    queryFn: () => api.listAgents({ scope: "global" }, false),
  });
  const save = useMutation({
    mutationFn: (defaultAgentId: string) =>
      api.saveSettings({ defaultAgentId }),
    onSuccess: async (view) => {
      queryClient.setQueryData(["settings"], view);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["session-agents"] });
    },
    onError: showError("Could not set the default agent"),
  });
  const current = settings.data?.effective.defaultAgentId ?? NO_DEFAULT;
  // A default that is not in the list (for example, deleted just now) shows
  // as none until the list refreshes.
  const known = (global.data ?? []).some((a) => a.id === current);
  const env = settings.data?.overriddenByEnv.defaultAgentId;
  return (
    <Select
      w={280}
      label="Default agent"
      description={
        env
          ? `Set by ${env}.`
          : "New sessions start with it, unless their project has a default of its own."
      }
      allowDeselect={false}
      searchable
      disabled={!!env || save.isPending}
      value={known ? current : NO_DEFAULT}
      onChange={(v) => save.mutate(v ?? NO_DEFAULT)}
      data={[
        { value: NO_DEFAULT, label: "None (the built-in Dispatcher)" },
        ...(global.data ?? []).map((a) => ({
          value: a.id,
          label: a.builtin ? `${a.name} (built-in)` : a.name,
        })),
      ]}
      {...(settings.isError ? { error: settings.error.message } : {})}
      {...(global.isError ? { error: global.error.message } : {})}
      {...(settings.isPending || global.isPending
        ? { rightSection: <Loader size="xs" /> }
        : {})}
    />
  );
}

/**
 * The project's default agent: new sessions in it start with this agent
 * (default agent design, decisions 1, 3, 4). The project's agents and the
 * global ones are offered, or none.
 */
export function DefaultAgentSelect({
  project,
  disabled,
}: {
  project: Project;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const own = useQuery({
    queryKey: [
      ...agentsKey({ scope: "project", id: project.id }),
      "list",
      false,
    ],
    queryFn: () => api.listAgents({ scope: "project", id: project.id }, false),
  });
  const global = useQuery({
    queryKey: [...agentsKey({ scope: "global" }), "list", false],
    queryFn: () => api.listAgents({ scope: "global" }, false),
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });
  // With none, new sessions start with the global default, if there is one.
  const globalDefault = (global.data ?? []).find(
    (a) => a.id === settings.data?.effective.defaultAgentId,
  );
  const save = useMutation({
    mutationFn: (defaultAgentId: string | null) =>
      api.updateProject(project.id, { defaultAgentId }),
    onSuccess: async (updated) => {
      queryClient.setQueryData<Project>(["project", project.id], updated);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["session-agents"] });
    },
    onError: showError("Could not set the default agent"),
  });
  const group = (
    label: string,
    scope: string,
    agents: { id: string; name: string; builtin?: boolean }[] | undefined,
  ) =>
    agents && agents.length > 0
      ? [
          {
            group: label,
            items: agents.map((a) => ({
              value: a.id,
              label: `${a.name} (${a.builtin ? "built-in" : scope})`,
            })),
          },
        ]
      : [];
  // A default that is not in the lists (for example, deleted just now)
  // shows as none until the lists refresh.
  const known = [...(own.data ?? []), ...(global.data ?? [])].some(
    (a) => a.id === project.default_agent_id,
  );
  return (
    <Select
      w={280}
      label="Default agent"
      description="New sessions in this project start with it."
      allowDeselect={false}
      searchable
      disabled={!!disabled || save.isPending}
      value={known ? project.default_agent_id : NO_DEFAULT}
      onChange={(v) => save.mutate(v === NO_DEFAULT || v === null ? null : v)}
      data={[
        {
          group: "",
          items: [
            {
              value: NO_DEFAULT,
              label: globalDefault
                ? `None (global default: ${globalDefault.name})`
                : "None (the built-in Dispatcher)",
            },
          ],
        },
        ...group("Project agents", "project", own.data),
        ...group("Global agents", "global", global.data),
      ]}
      {...(own.isError ? { error: own.error.message } : {})}
      {...(global.isError ? { error: global.error.message } : {})}
      {...(own.isPending || global.isPending
        ? { rightSection: <Loader size="xs" /> }
        : {})}
    />
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
      <DefaultAgentSelect project={project.data} disabled={trashed} />
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
      .map((a) => ({
        value: a.id,
        label: `${a.name} (${a.builtin ? "built-in" : scope})${a.isDefault ? " · Default" : ""}`,
      }));
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

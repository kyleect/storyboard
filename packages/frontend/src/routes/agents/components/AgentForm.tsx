import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  api,
  type AgentContent,
  type AgentDetail,
  type AgentScope,
} from "../../../api";
import { emptyGrant } from "../../../lib/tool-grant";
import {
  BuiltinBadge,
  DeletedBadge,
  download,
  fileName,
  SubagentSummary,
  ToolsSummary,
  useRefresh,
  useSelectableTools,
  useToolApprovals,
  VersionsModal,
  when,
} from "./AgentParts";
import { ToolGrantEditor } from "./ToolGrantEditor";
import { showError } from "../../../lib/notify";

export const emptyAgent = (): AgentContent => ({
  name: "",
  description: "",
  prompt: "",
  toolGrant: emptyGrant(),
  toolApproval: {},
  childReminders: null,
  childPrompt: null,
  subagent: false,
});

export const contentOf = (a: AgentContent): AgentContent => ({
  name: a.name,
  description: a.description,
  prompt: a.prompt,
  toolGrant: a.toolGrant,
  toolApproval: a.toolApproval,
  childReminders: a.childReminders,
  childPrompt: a.childPrompt,
  subagent: a.subagent,
});

const same = (a: AgentContent, b: AgentContent) =>
  JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b));

const PROMPT_HELP =
  "Write {{skills}}, {{tools}}, {{schemas}}, {{data}}, {{agents}} or {{workspaces}} to put the list of skills, tools, schemas, data, agents (the ones it can start) or workspaces the chat has at that place. Write {{date}} or {{time}} for the date or the time of day when the run starts. Wrap text in {{#skills}}…{{/skills}} (or any other of these names) to keep it only when the chat has some, and in {{^skills}}…{{/skills}} to keep it only when it has none. Write {{files}} to list the files the chat can see. Write {{skills_instruction}}, {{tools_instruction}}, {{schemas_instruction}}, {{data_instruction}}, {{agents_instruction}}, {{workspaces_instruction}} or {{files_instruction}} for the wording that introduces a list, apart from the list.";

export function AgentForm({
  scope,
  agent,
  start,
  readOnly,
  draft,
  onDraft,
  onKeep,
  onSaved,
  onDeleted,
  onCopy,
  openVersion,
}: {
  scope: AgentScope;
  agent: AgentDetail | undefined;
  start?: AgentContent | undefined;
  readOnly: string | undefined;
  draft: AgentContent | undefined;
  onDraft: (draft: AgentContent | undefined) => void;
  onKeep: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  onCopy: (source: AgentDetail) => void;
  openVersion?: number | undefined;
}) {
  const refresh = useRefresh(scope);
  const tools = useSelectableTools();
  const approvals = useToolApprovals();
  const [versions, setVersions] = useState(openVersion !== undefined);
  const known = tools.data ? new Set(tools.data.map((t) => t.name)) : undefined;

  const base = agent ? contentOf(agent) : (start ?? emptyAgent());
  const current = draft ?? base;
  const isNew = agent === undefined;
  const locked =
    readOnly !== undefined ||
    agent?.builtin === true ||
    agent?.deleted === true;
  const dirty = draft !== undefined;

  const change = (patch: Partial<AgentContent>) => {
    const next = { ...current, ...patch };
    onKeep();
    onDraft(!isNew && same(next, base) ? undefined : next);
  };

  const save = useMutation({
    mutationFn: () =>
      agent
        ? api.saveAgent(agent.id, current)
        : api.createAgent(scope, current),
    onSuccess: async (saved) => {
      onDraft(undefined);
      await refresh();
      onSaved(saved.id);
    },
    onError: showError("Could not save the agent"),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAgent(agent?.id ?? ""),
    onSuccess: async () => {
      await refresh();
      onDeleted();
    },
    onError: showError("Could not delete the agent"),
  });
  const exportFile = useMutation({
    mutationFn: () => api.exportAgent(agent?.id ?? ""),
    onSuccess: (text) => {
      if (agent) download(fileName(agent.name), text);
    },
    onError: showError("Could not export the agent"),
  });

  const newTools = new Set(agent && !locked ? agent.newTools : []);
  const why = agent?.builtin
    ? "Built in. It cannot be changed or deleted; Copy to global makes an agent of your own from it."
    : agent?.deleted
      ? "Deleted. Open Versions to restore it."
      : readOnly;

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Group
        justify="space-between"
        wrap="nowrap"
        px="sm"
        py={6}
        style={{
          borderBottom: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text fw={600} size="sm" truncate>
            {current.name || "New agent"}
          </Text>
          {agent && (
            <Badge size="xs" variant="light" color="gray">
              v{agent.version}
            </Badge>
          )}
          {agent?.deleted && <DeletedBadge />}
          {agent?.builtin && <BuiltinBadge />}
          {agent && !locked && (
            <Text size="xs" c="dimmed" truncate>
              Changed {when(agent.updatedAt)}
            </Text>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          {agent && !agent.builtin && (
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => setVersions(true)}
            >
              Versions ({agent.versions.length})
            </Button>
          )}
          {agent && (
            <Button
              size="compact-xs"
              variant="default"
              loading={exportFile.isPending}
              onClick={() => exportFile.mutate()}
            >
              Export
            </Button>
          )}
          {agent?.builtin && (
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => onCopy(agent)}
            >
              Copy to global
            </Button>
          )}
          {agent && !locked && (
            <Button
              size="compact-xs"
              variant="light"
              color="red"
              loading={remove.isPending}
              onClick={() =>
                modals.openConfirmModal({
                  title: `Delete “${agent.name}”?`,
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
          )}
          {!locked && (
            <>
              {dirty && !isNew && (
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={() => onDraft(undefined)}
                >
                  Revert
                </Button>
              )}
              <Button
                size="compact-xs"
                disabled={current.name.trim() === "" || (!isNew && !dirty)}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                Save
              </Button>
            </>
          )}
        </Group>
      </Group>
      {why && (
        <Text size="xs" c="dimmed" px="sm" pt={6}>
          {why}
        </Text>
      )}
      {newTools.size > 0 && (
        <Alert color="blue" p="xs" m="sm" title="New tools">
          {newTools.size === 1
            ? "1 tool has been added since this agent was last saved: "
            : `${newTools.size} tools have been added since this agent was last saved: `}
          {[...newTools].join(", ")}. Save the agent to count them as seen.
        </Alert>
      )}
      <Box
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
          alignItems: "stretch",
        }}
      >
        <Stack p="sm" gap="xs" style={{ flex: 1, minWidth: 0 }}>
          <Textarea
            label="System prompt"
            description={PROMPT_HELP}
            disabled={locked}
            value={current.prompt}
            onChange={(e) => change({ prompt: e.currentTarget.value })}
            autosize
            minRows={14}
            maxRows={40}
          />
        </Stack>
        <ScrollArea
          w={360}
          style={{
            flexShrink: 0,
            borderLeft: "1px solid var(--mantine-color-default-border)",
          }}
        >
          <Stack p="sm" gap="lg">
            <TextInput
              label="Name"
              description="Unique among this scope's agents. Case-sensitive."
              disabled={locked}
              value={current.name}
              onChange={(e) => change({ name: e.currentTarget.value })}
            />
            <TextInput
              label="Description"
              description="Optional."
              disabled={locked}
              value={current.description}
              onChange={(e) => change({ description: e.currentTarget.value })}
            />
            {locked ? (
              <Stack gap="xs">
                <Text size="sm" fw={500}>
                  As a subagent
                </Text>
                <SubagentSummary agent={current} />
                <Text size="sm" fw={500}>
                  Tools
                </Text>
                <ToolsSummary
                  toolGrant={current.toolGrant}
                  toolApproval={current.toolApproval}
                  known={known}
                />
              </Stack>
            ) : (
              <>
                <Stack gap="xs">
                  <Text size="sm" fw={500}>
                    As a subagent
                  </Text>
                  <Switch
                    label="Can be started by other agents"
                    description="Other agents can hand work to this one with start_subagent. Off unless you turn it on."
                    checked={current.subagent}
                    onChange={(e) =>
                      change({ subagent: e.currentTarget.checked })
                    }
                  />
                  <Switch
                    label="Use the global number of reminders"
                    description="How many times it is reminded to hand back when it stops without doing so."
                    checked={current.childReminders === null}
                    onChange={(e) =>
                      change({
                        childReminders: e.currentTarget.checked ? null : 2,
                      })
                    }
                  />
                  {current.childReminders !== null && (
                    <NumberInput
                      aria-label="Reminders"
                      allowDecimal={false}
                      min={0}
                      w={120}
                      value={current.childReminders}
                      onChange={(v) =>
                        change({
                          childReminders: typeof v === "number" ? v : 0,
                        })
                      }
                    />
                  )}
                  <Switch
                    label="Use the global subagent line"
                    description="Added at the end of its system message when it runs as a subagent."
                    checked={current.childPrompt === null}
                    onChange={(e) =>
                      change({
                        childPrompt: e.currentTarget.checked ? null : "",
                      })
                    }
                  />
                  {current.childPrompt !== null && (
                    <Textarea
                      aria-label="Subagent line"
                      autosize
                      minRows={2}
                      value={current.childPrompt}
                      onChange={(e) =>
                        change({ childPrompt: e.currentTarget.value })
                      }
                    />
                  )}
                  {current.childPrompt !== null &&
                    current.childPrompt.trim() === "" && (
                      <Alert color="yellow" p="xs">
                        Without this line, subagents might not work correctly:
                        they may not know to hand back or to ask you with a
                        form.
                      </Alert>
                    )}
                </Stack>
                <Stack gap="xs">
                  <Text size="sm" fw={500}>
                    Tools
                  </Text>
                  <Text size="xs" c="dimmed">
                    Tools that are always on are ticked and locked. For each
                    tool or group, you can also choose whether this agent asks
                    before a call, or follows the tool&apos;s own setting.
                    Saving counts new tools as seen.
                  </Text>
                  {(tools.isPending || approvals.isPending) && (
                    <Loader size="xs" />
                  )}
                  {tools.isError && (
                    <Alert color="red">{tools.error.message}</Alert>
                  )}
                  {approvals.isError && (
                    <Alert color="red">{approvals.error.message}</Alert>
                  )}
                  {tools.data && approvals.data && (
                    <ToolGrantEditor
                      grant={current.toolGrant}
                      onGrant={(toolGrant) => change({ toolGrant })}
                      approval={current.toolApproval}
                      onApproval={(toolApproval) => change({ toolApproval })}
                      tools={tools.data}
                      approvals={approvals.data}
                      newTools={newTools}
                    />
                  )}
                </Stack>
              </>
            )}
          </Stack>
        </ScrollArea>
      </Box>
      {versions && agent && (
        <VersionsModal
          scope={scope}
          agent={agent}
          readOnly={readOnly !== undefined}
          initial={openVersion}
          onClose={() => setVersions(false)}
        />
      )}
    </Box>
  );
}

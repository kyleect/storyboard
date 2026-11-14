import { Badge, Group, Paper, Stack, Text } from "@mantine/core";
import utils from "../../../styles/utilities.module.css";
import { VersionsModal as GenericVersionsModal } from "../../../components/VersionsModal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TOOL_GROUPS } from "@harness/core";
import {
  api,
  type AgentContent,
  type AgentDetail,
  type AgentScope,
} from "../../../api";
import { agentKeys, sessionKeys, toolKeys } from "../../../queries";
import type { ToolGrant } from "../../../lib/tool-grant";

export function useRefresh(scope: AgentScope) {
  const queryClient = useQueryClient();

  return async () => {
    await queryClient.invalidateQueries({
      queryKey: agentKeys.scopeLists(scope),
    });
    await queryClient.invalidateQueries({
      queryKey: agentKeys.copyTargets(scope),
    });
    await queryClient.invalidateQueries({ queryKey: agentKeys.details() });
    await queryClient.invalidateQueries({
      queryKey: sessionKeys.pickableAgents(),
    });
  };
}

export function useSelectableTools() {
  return useQuery({ queryKey: toolKeys.selectable(), queryFn: api.agentTools });
}

export function useToolApprovals() {
  return useQuery({
    queryKey: toolKeys.approvals(),
    queryFn: api.agentToolApprovals,
  });
}

export function DefaultBadge() {
  return <Badge>Default</Badge>;
}

export function BuiltinBadge() {
  return <Badge color="teal">built-in</Badge>;
}

export function SubagentSummary({ agent }: { agent: AgentContent }) {
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

export function DeletedBadge() {
  return <Badge color="red">deleted</Badge>;
}

export function TextBox({ value }: { value: string }) {
  return (
    <Paper p="sm">
      <Text size="sm" className={utils.preWrap}>
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

export function ToolsSummary({
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
            <Badge key={g} size="sm" tt="none">
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

export function VersionContent({
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

export function VersionsModal({
  scope,
  agent,
  readOnly,
  initial,
  onClose,
}: {
  scope: AgentScope;
  agent: AgentDetail;
  readOnly: boolean;
  initial?: number | undefined;
  onClose: () => void;
}) {
  const refresh = useRefresh(scope);
  const tools = useSelectableTools();
  const known = tools.data ? new Set(tools.data.map((t) => t.name)) : undefined;

  return (
    <GenericVersionsModal
      title={`Versions of ${agent.name}`}
      versions={agent.versions}
      initialSeq={initial}
      listWidth={220}
      bodyHeight="55vh"
      label={(v) => (
        <Group gap={4}>
          <Text size="sm">v{v.seq}</Text>
          {v.deleted && <DeletedBadge />}
        </Group>
      )}
      note={(v) => (
        <Text size="sm" c="dimmed">
          {v.deleted ? "Deleted here; the content it had is shown." : ""}
        </Text>
      )}
      body={(v) => <VersionContent v={v} known={known} />}
      restore={
        readOnly
          ? undefined
          : {
              run: (seq) => api.restoreAgent(agent.id, seq),
              afterRestore: refresh,
              isCurrent: (v) => v.seq === agent.version && !agent.deleted,
              canRestore: (v) => !v.deleted,
            }
      }
      onClose={onClose}
    />
  );
}

export function download(filename: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/markdown;charset=utf-8" }),
  );
  const a = document.createElement("a");

  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const fileName = (name: string) =>
  `${[...name]
    .map((c) => (c < " " || '\\/:*?"<>|'.includes(c) ? "_" : c))
    .join("")}.md`;

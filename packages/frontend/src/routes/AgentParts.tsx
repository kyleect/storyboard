import {
  Badge,
  Button,
  Group,
  Modal,
  NavLink,
  Paper,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { TOOL_GROUPS } from "@harness/core";
import {
  api,
  type AgentContent,
  type AgentDetail,
  type AgentScope,
  type AgentVersion,
} from "../api";
import { agentKeys, sessionKeys, toolKeys } from "../queries";
import type { ToolGrant } from "../tool-grant";
import { showError } from "./SessionActions";

/*
 * What the agents screens share: the lists' badges, the words for an agent's
 * tools and subagent settings, and the versions of an agent.
 */

export const when = (iso: string) =>
  iso ? new Date(iso).toLocaleString() : "";

/** Refreshes a scope's lists and open agents after a change. */
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

/** The tools an agent can select, by name. */
export function useSelectableTools() {
  return useQuery({ queryKey: toolKeys.selectable(), queryFn: api.agentTools });
}

/** Every tool with its setting now, for the approval choices. */
export function useToolApprovals() {
  return useQuery({
    queryKey: toolKeys.approvals(),
    queryFn: api.agentToolApprovals,
  });
}

export function DefaultBadge() {
  return (
    <Badge size="xs" variant="light">
      Default
    </Badge>
  );
}

export function BuiltinBadge() {
  return (
    <Badge size="xs" variant="light" color="teal">
      built-in
    </Badge>
  );
}

/** What an agent's subagent settings say, for its page. */
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
  return (
    <Badge size="xs" variant="light" color="red">
      deleted
    </Badge>
  );
}

/** Text in a box, keeping line breaks. */
export function TextBox({ value }: { value: string }) {
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

/** An agent's versions; one can be made current (decision 21). */
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
  /** The version to show first; the newest if left out or not there. */
  initial?: number | undefined;
  onClose: () => void;
}) {
  const refresh = useRefresh(scope);
  const tools = useSelectableTools();
  const known = tools.data ? new Set(tools.data.map((t) => t.name)) : undefined;
  const newestFirst = [...agent.versions].reverse();
  const [picked, setPicked] = useState<AgentVersion | undefined>(
    newestFirst.find((v) => v.seq === initial) ?? newestFirst[0],
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

/** The name with characters file systems refuse replaced by "_". */
export const fileName = (name: string) =>
  `${[...name]
    .map((c) => (c < " " || '\\/:*?"<>|'.includes(c) ? "_" : c))
    .join("")}.md`;

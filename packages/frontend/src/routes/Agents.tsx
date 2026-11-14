import {
  Alert,
  Badge,
  Box,
  Loader,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  api,
  type MessageAgent,
  type PickableAgent,
  type Project,
} from "../api";
import { agentKeys, projectKeys, sessionKeys, settingsKeys } from "../queries";
import { showError } from "./SessionActions";
import { AgentsExplorer } from "./AgentsExplorer";
import { useAgentFocus } from "../agent-focus";
import { useReportDirty } from "../dirty";
import { ApprovalSelect } from "./ApprovalSelect";

export { ApprovalSelect };

/*
 * Agents (agents design, decisions 15 and 30 to 37): a page per scope with
 * the list on the left and the selected agent on the right, as on the files
 * page; the picker in the chat view; and the read-only view of the version
 * a message was written with.
 */

/** Global agents (decision 30). */
export function GlobalAgentsPage() {
  return (
    <Stack gap="md">
      <Title order={3}>Agents</Title>
      <Text size="sm" c="dimmed">
        Global: every session can use these.
      </Text>
      <AgentsView height="calc(100vh - 17rem)" />
    </Stack>
  );
}

/** The agents explorer, with the guard against leaving unsaved edits. */
function AgentsView({
  projectId,
  readOnly,
  height,
}: {
  projectId?: string;
  readOnly?: string | undefined;
  height: string;
}) {
  const [dirty, setDirty] = useState(false);
  useReportDirty(dirty);
  return (
    <Box h={height} mih={420}>
      <AgentsExplorer
        projectId={projectId}
        readOnly={readOnly}
        onDirtyChange={setDirty}
      />
    </Box>
  );
}

const NO_DEFAULT = "";

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
    queryKey: agentKeys.list({ scope: "project", id: project.id }, false),
    queryFn: () => api.listAgents({ scope: "project", id: project.id }, false),
  });
  const global = useQuery({
    queryKey: agentKeys.list({ scope: "global" }, false),
    queryFn: () => api.listAgents({ scope: "global" }, false),
  });
  const settings = useQuery({
    queryKey: settingsKeys.all,
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
      queryClient.setQueryData<Project>(
        projectKeys.detail(project.id),
        updated,
      );
      await queryClient.invalidateQueries({ queryKey: projectKeys.list() });
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
      await queryClient.invalidateQueries({
        queryKey: sessionKeys.pickableAgents(),
      });
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
export function ProjectAgentsPage({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => api.getProject(projectId),
  });
  if (project.isPending) return <Loader />;
  if (project.isError)
    return <Alert color="red">{project.error.message}</Alert>;
  const trashed = project.data.trashed_at !== null;
  return (
    <AgentsView
      key={projectId}
      height="calc(100vh - 19rem)"
      projectId={projectId}
      readOnly={
        trashed
          ? "The project is in the trash, so these can be read but not changed."
          : undefined
      }
    />
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
    queryKey: sessionKeys.pickableAgentsFor(sessionId),
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
 * it opens the agent's tab in the Agents view, with its Versions list on that
 * version (agents explorer design, decision 10).
 */
export function AgentBadge({ agent }: { agent: MessageAgent }) {
  const navigate = useNavigate();
  const ask = useAgentFocus((s) => s.ask);
  return (
    <Badge
      size="xs"
      variant="light"
      color="teal"
      tt="none"
      style={{ cursor: "pointer" }}
      onClick={() => {
        ask({
          agentId: agent.id,
          version: agent.version,
          projectId: agent.projectId,
        });
        void navigate({
          to: agent.projectId
            ? `/projects/${encodeURIComponent(agent.projectId)}/agents`
            : "/agents",
        } as never);
      }}
      title="Show this version of the agent"
    >
      {agent.name} v{agent.version}
    </Badge>
  );
}

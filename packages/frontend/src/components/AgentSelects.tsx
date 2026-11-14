import { Badge, Loader, Select } from "@mantine/core";
import utils from "../styles/utilities.module.css";
import { useSetDefaultAgent } from "../hooks/useProjects";
import { useSettings } from "../hooks/useSettings";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  api,
  type MessageAgent,
  type PickableAgent,
  type Project,
} from "../api";
import { agentKeys, sessionKeys } from "../queries";
import { useAgentFocus } from "../stores/agentFocus";

export const NO_DEFAULT = "";
export function DefaultAgentSelect({
  project,
  disabled,
}: {
  project: Project;
  disabled?: boolean;
}) {
  const own = useQuery({
    queryKey: agentKeys.list({ scope: "project", id: project.id }, false),
    queryFn: () => api.listAgents({ scope: "project", id: project.id }, false),
  });
  const global = useQuery({
    queryKey: agentKeys.list({ scope: "global" }, false),
    queryFn: () => api.listAgents({ scope: "global" }, false),
  });
  const settings = useSettings();
  const globalDefault = (global.data ?? []).find(
    (a) => a.id === settings.data?.effective.defaultAgentId,
  );
  const save = useSetDefaultAgent(project.id);
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
export const NO_AGENT = "";
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
      size="xs"
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
export function AgentBadge({ agent }: { agent: MessageAgent }) {
  const navigate = useNavigate();
  const ask = useAgentFocus((s) => s.ask);
  return (
    <Badge
      color="teal"
      tt="none"
      size="sm"
      radius="sm"
      variant="gradient"
      className={utils.pointer}
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

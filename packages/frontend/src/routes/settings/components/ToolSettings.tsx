import {
  Alert,
  Badge,
  Checkbox,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ToolGroupChange, type ToolView } from "../../../api";
import { toolKeys } from "../../../queries";
import { groupTools } from "../../../lib/tool-grant";

type Setting = "ask" | "alwaysOn" | "off";

function stateOf(tools: ToolView[], setting: Setting) {
  const usable = setting === "ask" ? tools.filter((t) => !t.fixed) : tools;
  const on = usable.filter((t) => t[setting]).length;
  return {
    all: usable.length > 0 && on === usable.length,
    some: on > 0 && on < usable.length,
    none: on === 0,
    count: usable.length,
  };
}

const unique = (list: string[]) => [...new Set(list)].sort();

export function ToolSettings() {
  const queryClient = useQueryClient();
  const tools = useQuery({ queryKey: toolKeys.list(), queryFn: api.listTools });

  const refreshAgents = () => {
    void queryClient.invalidateQueries({ queryKey: toolKeys.approvals() });
    void queryClient.invalidateQueries({ queryKey: toolKeys.selectable() });
  };
  const merge = (updated: ToolView[]) => {
    queryClient.setQueryData<ToolView[]>(toolKeys.list(), (old) =>
      old?.map((t) => updated.find((u) => u.name === t.name) ?? t),
    );
    refreshAgents();
  };
  const failed = (err: Error) =>
    notifications.show({
      color: "red",
      title: "Could not save",
      message: err.message,
    });

  const change = useMutation({
    mutationFn: (c: { name: string; setting: Setting; value: boolean }) =>
      c.setting === "ask"
        ? api.setToolAsks(c.name, c.value)
        : c.setting === "alwaysOn"
          ? api.setToolAlwaysOn(c.name, c.value)
          : api.setToolOff(c.name, c.value),
    onSuccess: (updated: ToolView) => merge([updated]),
    onError: failed,
  });
  const changeGroup = useMutation({
    mutationFn: (c: { group: ToolView["group"]; change: ToolGroupChange }) =>
      api.setToolGroup(c.group, c.change),
    onSuccess: merge,
    onError: failed,
  });
  const busy = change.isPending || changeGroup.isPending;

  const confirmOff = (affected: ToolView[], go: () => void) => {
    const agents = unique(affected.flatMap((t) => t.usedByAgents));
    if (agents.length === 0) return go();
    modals.openConfirmModal({
      title: "Switch off?",
      children: (
        <Stack gap="xs">
          <Text size="sm">
            {affected.length === 1
              ? "These agents list this tool, and will not get it while it is off:"
              : "These agents list tools in this group, and will not get them while they are off:"}
          </Text>
          <Text size="sm" fw={500}>
            {agents.join(", ")}
          </Text>
        </Stack>
      ),
      labels: { confirm: "Switch off", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: go,
    });
  };

  const setOne = (t: ToolView, setting: Setting, value: boolean) => {
    const go = () => change.mutate({ name: t.name, setting, value });
    if (setting === "off" && value) confirmOff([t], go);
    else go();
  };
  const setAll = (
    group: ToolView["group"],
    inGroup: ToolView[],
    c: ToolGroupChange,
  ) => {
    const go = () => changeGroup.mutate({ group, change: c });
    if (c.off)
      confirmOff(
        inGroup.filter((t) => !t.off),
        go,
      );
    else go();
  };

  return (
    <Stack gap="xs">
      <Title order={4}>Tools</Title>
      <Text size="xs" c="dimmed">
        For each tool: whether every agent has it (always on), whether it asks
        before it runs, and whether it is off for the whole harness. A
        group&apos;s header sets all of its tools. Saved when changed.
      </Text>
      {tools.isPending && <Loader size="sm" />}
      {tools.isError && <Alert color="red">{tools.error.message}</Alert>}
      {tools.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          No tools.
        </Text>
      )}
      {groupTools(tools.data ?? []).map(({ id, label, tools: inGroup }) => {
        const always = stateOf(inGroup, "alwaysOn");
        const off = stateOf(inGroup, "off");
        const ask = stateOf(inGroup, "ask");
        return (
          <Paper key={id} withBorder p="xs">
            <Stack gap="sm">
              <Group justify="space-between" wrap="nowrap">
                <Text size="sm" fw={500}>
                  {label}
                </Text>
                <Group gap="md" wrap="nowrap">
                  <Checkbox
                    size="xs"
                    label="Always on"
                    aria-label={`Always on for ${label} tools`}
                    checked={always.all}
                    indeterminate={always.some}
                    disabled={busy}
                    onChange={() =>
                      setAll(id, inGroup, { alwaysOn: !always.all })
                    }
                  />
                  <Select
                    size="xs"
                    w={170}
                    aria-label={`Ask before running for ${label} tools`}
                    allowDeselect={false}
                    placeholder="Mixed"
                    disabled={busy || ask.count === 0}
                    data={[
                      { value: "ask", label: "Ask for all" },
                      { value: "skip", label: "Don't ask for all" },
                    ]}
                    value={ask.all ? "ask" : ask.none ? "skip" : null}
                    onChange={(v) =>
                      v && setAll(id, inGroup, { ask: v === "ask" })
                    }
                  />
                  <Checkbox
                    size="xs"
                    label="Off"
                    aria-label={`Off for ${label} tools`}
                    checked={off.all}
                    indeterminate={off.some}
                    disabled={busy}
                    onChange={() => setAll(id, inGroup, { off: !off.all })}
                  />
                </Group>
              </Group>
              {inGroup.map((t) => (
                <Group
                  key={t.name}
                  justify="space-between"
                  align="flex-start"
                  wrap="nowrap"
                >
                  <Stack gap={2}>
                    <Group gap={6}>
                      <Text size="sm">{t.name}</Text>
                      {t.needsReview && (
                        <Badge size="xs" variant="light" color="orange">
                          needs review
                        </Badge>
                      )}
                      {t.off && t.usedByAgents.length > 0 && (
                        <Badge size="xs" variant="light" color="red">
                          off, listed by {t.usedByAgents.length}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {t.description}
                      {t.fixed
                        ? " Always asks; this cannot be changed."
                        : ` Default: ${t.askByDefault ? "asks" : "runs without asking"}${
                            t.alwaysOnByDefault ? ", always on" : ""
                          }.`}
                    </Text>
                  </Stack>
                  <Group gap="md" wrap="nowrap">
                    <Switch
                      size="xs"
                      label="Always on"
                      aria-label={`${t.name}: always on`}
                      checked={t.alwaysOn}
                      disabled={busy}
                      onChange={(e) =>
                        setOne(t, "alwaysOn", e.currentTarget.checked)
                      }
                    />
                    <Switch
                      size="xs"
                      label="Ask"
                      aria-label={`${t.name}: ask before running`}
                      checked={t.ask}
                      disabled={busy || t.fixed}
                      onChange={(e) =>
                        setOne(t, "ask", e.currentTarget.checked)
                      }
                    />
                    <Switch
                      size="xs"
                      label="Off"
                      aria-label={`${t.name}: off`}
                      checked={t.off}
                      disabled={busy}
                      onChange={(e) =>
                        setOne(t, "off", e.currentTarget.checked)
                      }
                    />
                  </Group>
                </Group>
              ))}
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}

import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { useState } from "react";
import type { AgentToolInfo, ToolApprovalInfo } from "../api";
import {
  forget,
  groupApproval,
  groupCount,
  groupTools,
  hasTool,
  setGroup,
  setGroupApproval,
  setTool,
  switchMode,
  toggleState,
  type GroupApproval,
  type ToolGrant,
  type ToolMode,
} from "../tool-grant";
import { ApprovalSelect } from "./ApprovalSelect";

/*
 * The tools part of the agent editor (tool management design, decisions 1
 * to 8): tools in groups, each group with its own on/off box and approval
 * choice, tools that are new since the last save marked, and tools that are
 * always on shown locked.
 */

const GROUP_CHOICES = [
  { value: "own", label: "Each tool's setting" },
  { value: "ask", label: "Ask for all" },
  { value: "skip", label: "Don't ask for all" },
];

export function ToolGrantEditor({
  grant,
  onGrant,
  approval,
  onApproval,
  tools,
  approvals,
  newTools,
}: {
  grant: ToolGrant;
  onGrant: (g: ToolGrant) => void;
  approval: Record<string, boolean>;
  onApproval: (a: Record<string, boolean>) => void;
  tools: AgentToolInfo[];
  approvals: ToolApprovalInfo[];
  /** Names of tools added since the agent was last saved. */
  newTools: ReadonlySet<string>;
}) {
  const groups = groupTools(tools);
  const approvalOf = (name: string) => approvals.find((t) => t.name === name);
  const isFixed = (name: string) => approvalOf(name)?.fixed ?? false;
  // Groups with something new start open, so it is not missed.
  const [open, setOpen] = useState<ReadonlySet<string>>(
    new Set(
      groups
        .filter((g) => g.tools.some((t) => newTools.has(t.name)))
        .map((g) => g.id),
    ),
  );
  const toggleOpen = (id: string) =>
    setOpen((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const setAsk = (tool: string, ask: boolean | undefined) => {
    const rest = Object.fromEntries(
      Object.entries(approval).filter(([n]) => n !== tool),
    );
    onApproval(ask === undefined ? rest : { ...rest, [tool]: ask });
  };

  const known = new Set(tools.map((t) => t.name));
  // Stored names with no such tool, shown so they can be removed.
  const missing = [...grant.except, ...grant.extras].filter(
    (n, i, all) => !known.has(n) && all.indexOf(n) === i,
  );
  const missingApproval = Object.keys(approval).filter(
    (n) => approvals.length > 0 && !approvalOf(n),
  );

  return (
    <Stack gap="xs">
      <SegmentedControl
        size="xs"
        w="fit-content"
        value={grant.mode}
        onChange={(v) => onGrant(switchMode(grant, v as ToolMode, tools))}
        data={[
          { value: "allow", label: "Only the ticked tools" },
          { value: "deny", label: "Every tool except the unticked ones" },
        ]}
      />
      {grant.mode === "deny" && (
        <Text size="xs" c="dimmed">
          Tools that need review are left out here too: tick one to give it to
          this agent.
        </Text>
      )}
      {groups.map(({ id, label, tools: inGroup }) => {
        const state = toggleState(grant, inGroup);
        const { on, total } = groupCount(grant, inGroup);
        const fresh = inGroup.filter((t) => newTools.has(t.name)).length;
        const current = groupApproval(
          approval,
          inGroup.map((t) => ({ name: t.name, fixed: isFixed(t.name) })),
        );
        const isOpen = open.has(id);
        return (
          <Paper key={id} withBorder p="xs">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap">
                <Checkbox
                  aria-label={`${label} tools`}
                  checked={state === "all"}
                  indeterminate={state === "mixed"}
                  onChange={() =>
                    onGrant(setGroup(grant, id, inGroup, state !== "all"))
                  }
                />
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  aria-label={`${isOpen ? "Hide" : "Show"} ${label} tools`}
                  aria-expanded={isOpen}
                  onClick={() => toggleOpen(id)}
                >
                  {isOpen ? "▾" : "▸"}
                </ActionIcon>
                <Text size="sm" fw={500}>
                  {label}
                </Text>
                <Text size="xs" c="dimmed">
                  {on} of {total}
                </Text>
                {fresh > 0 && (
                  <Badge size="xs" color="blue" variant="light">
                    {fresh} new
                  </Badge>
                )}
              </Group>
              <Select
                size="xs"
                w={180}
                aria-label={`Approval for ${label} tools`}
                allowDeselect={false}
                placeholder="Mixed"
                data={GROUP_CHOICES}
                value={current === "mixed" ? null : current}
                onChange={(v) => {
                  if (v)
                    onApproval(
                      setGroupApproval(
                        approval,
                        inGroup.map((t) => ({
                          name: t.name,
                          fixed: isFixed(t.name),
                        })),
                        v as Exclude<GroupApproval, "mixed">,
                      ),
                    );
                }}
              />
            </Group>
            {isOpen && (
              <Stack gap="md" mt="sm" pl="md">
                {inGroup.map((t) => (
                  <Group
                    key={t.name}
                    justify="space-between"
                    align="flex-start"
                    wrap="nowrap"
                  >
                    <Checkbox
                      checked={hasTool(grant, t)}
                      disabled={t.alwaysOn}
                      onChange={(e) =>
                        onGrant(setTool(grant, t, e.currentTarget.checked))
                      }
                      label={
                        <Group gap={6}>
                          <span>{t.name}</span>
                          {t.alwaysOn && (
                            <Badge size="xs" variant="outline" color="gray">
                              always on
                            </Badge>
                          )}
                          {newTools.has(t.name) && (
                            <Badge size="xs" variant="light" color="blue">
                              new
                            </Badge>
                          )}
                          {t.needsReview && (
                            <Badge size="xs" variant="light" color="orange">
                              needs review
                            </Badge>
                          )}
                          {t.off && (
                            <Badge size="xs" variant="light" color="red">
                              off in Settings
                            </Badge>
                          )}
                        </Group>
                      }
                      description={t.description}
                    />
                    <ApprovalSelect
                      tool={approvalOf(t.name)}
                      value={approval[t.name]}
                      disabled={!hasTool(grant, t)}
                      onChange={(ask) => setAsk(t.name, ask)}
                    />
                  </Group>
                ))}
              </Stack>
            )}
          </Paper>
        );
      })}
      {missing.map((n) => (
        <Group key={n} justify="space-between" wrap="nowrap">
          <Stack gap={0}>
            <Text size="sm" c="red">
              {n} (missing)
            </Text>
            <Text size="xs" c="dimmed">
              No tool has this name any more.
            </Text>
          </Stack>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => onGrant(forget(grant, n))}
          >
            Remove
          </Button>
        </Group>
      ))}
      {missingApproval.map((n) => (
        <Group key={n} justify="space-between" wrap="nowrap">
          <Stack gap={0}>
            <Text size="sm" c="red">
              {n} (missing)
            </Text>
            <Text size="xs" c="dimmed">
              No tool has this name any more. Remove its approval setting.
            </Text>
          </Stack>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => setAsk(n, undefined)}
          >
            Remove
          </Button>
        </Group>
      ))}
    </Stack>
  );
}

import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useState } from "react";
import type { AgentToolInfo } from "../../../api";
import {
  forget,
  groupCount,
  hasTool,
  setGroup,
  setTool,
  setTools,
  switchMode,
  toggleState,
  type ToolSection,
  type ToolMode,
} from "../../../lib/tool-grant";
import {
  ApprovalChoice,
  ToolApprovalMenu,
  ToolBadges,
  toolEditing,
  type ToolEditorProps,
} from "./ToolGrantParts";

const ALLOWED_BG =
  "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-6))";
const ALLOWED_BORDER =
  "1px solid light-dark(var(--mantine-color-blue-2), var(--mantine-color-blue-9))";

export function ToolGrantEditor(props: ToolEditorProps) {
  const { grant, onGrant, approval, tools, newTools } = props;
  const edit = toolEditing(props);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        edit.all
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

  const renderTool = (t: AgentToolInfo) => (
    <Stack key={t.name} gap={4}>
      <Checkbox
        checked={hasTool(grant, t)}
        disabled={t.alwaysOn}
        onChange={(e) => onGrant(setTool(grant, t, e.currentTarget.checked))}
        label={
          <Group gap={6}>
            <span>{t.name}</span>
            <ToolBadges tool={t} isNew={newTools.has(t.name)} />
          </Group>
        }
        description={
          <Text component="span" display="block" size="xs" lineClamp={2}>
            {t.description}
          </Text>
        }
      />
      <Box ml={28}>
        <ToolApprovalMenu
          tool={edit.approvalOf(t.name)}
          value={approval[t.name]}
          disabled={!hasTool(grant, t)}
          onChange={(ask) => edit.setAsk(t.name, ask)}
        />
      </Box>
    </Stack>
  );

  const renderSection = ({
    id,
    group,
    label,
    tools: inGroup,
    children,
  }: ToolSection<AgentToolInfo>) => {
    const state = toggleState(grant, inGroup);
    const { on, total } = groupCount(grant, inGroup);
    const fresh = inGroup.filter((t) => newTools.has(t.name)).length;
    const choice = edit.choiceOf(inGroup);
    const isOpen = open.has(id);
    const nested = id !== group;
    const allowed = state !== "none";

    return (
      <Paper
        key={id}
        p="sm"
        radius="md"
        withBorder={!nested}
        {...(allowed && !nested ? { bg: ALLOWED_BG, bd: ALLOWED_BORDER } : {})}
      >
        <Group gap="sm" wrap="nowrap">
          <Checkbox
            aria-label={`${label} tools`}
            checked={state === "all"}
            indeterminate={state === "mixed"}
            onChange={() =>
              onGrant(
                nested
                  ? setTools(grant, inGroup, state !== "all")
                  : setGroup(grant, group, inGroup, state !== "all"),
              )
            }
          />
          <Text size="sm" fw={600} flex={1} miw={0} truncate>
            {label}
          </Text>
          <Badge variant="light" color={allowed ? "blue" : "gray"}>
            {`${on} of ${total}`}
          </Badge>
          {fresh > 0 && <Badge color="blue">{fresh} new</Badge>}
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`${isOpen ? "Hide" : "Show"} ${label} tools`}
            aria-expanded={isOpen}
            onClick={() => toggleOpen(id)}
          >
            {isOpen ? (
              <IconChevronDown size={16} />
            ) : (
              <IconChevronRight size={16} />
            )}
          </ActionIcon>
        </Group>
        {allowed && (
          <Stack gap={4} mt="xs">
            <ApprovalChoice
              label={`Approval for ${label} tools`}
              value={choice}
              onChange={(v) => edit.setChoice(inGroup, v)}
            />
            {choice === "mixed" && (
              <Text size="xs" c="dimmed">
                Mixed: its tools differ.
              </Text>
            )}
          </Stack>
        )}
        {isOpen && children && (
          <Stack gap="xs" mt="sm">
            {children.map((child) => renderSection(child))}
          </Stack>
        )}
        {isOpen && !children && (
          <Stack gap="md" mt="sm">
            {inGroup.map(renderTool)}
          </Stack>
        )}
      </Paper>
    );
  };

  return (
    <Stack gap="xs">
      <SegmentedControl
        size="xs"
        fullWidth
        value={grant.mode}
        onChange={(v) => onGrant(switchMode(grant, v as ToolMode, tools))}
        data={[
          { value: "allow", label: "Only ticked tools" },
          { value: "deny", label: "All except unticked" },
        ]}
      />
      {grant.mode === "deny" && (
        <Text size="xs" c="dimmed">
          Tools that need review are left out here too: tick one to give it to
          this agent.
        </Text>
      )}
      {edit.sections.map(renderSection)}
      {edit.missing.map((n) => (
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
      {edit.missingApproval.map((n) => (
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
            onClick={() => edit.setAsk(n, undefined)}
          >
            Remove
          </Button>
        </Group>
      ))}
    </Stack>
  );
}

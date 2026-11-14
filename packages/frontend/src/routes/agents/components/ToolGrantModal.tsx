import {
  Box,
  Button,
  Checkbox,
  Flex,
  Group,
  Modal,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  IconAdjustmentsHorizontal,
  IconCheck,
  IconHelpCircle,
  IconLock,
} from "@tabler/icons-react";
import { useState } from "react";
import type { AgentToolInfo } from "../../../api";
import {
  groupCount,
  hasTool,
  setGroup,
  setTool,
  setTools,
  switchMode,
  toggleState,
  type GroupApproval,
  type ToolGrant,
  type ToolMode,
  type ToolSection,
} from "../../../lib/tool-grant";
import classes from "./ToolGrantModal.module.css";
import {
  ApprovalChoice,
  ToolBadges,
  toolEditing,
  type ToolEditorProps,
} from "./ToolGrantParts";

type Props = Omit<ToolEditorProps, "onGrant" | "onApproval"> & {
  agentName: string;
  onApply: (grant: ToolGrant, approval: Record<string, boolean>) => void;
  onClose: () => void;
};

const groupIcon = (choice: GroupApproval) =>
  choice === "ask" ? (
    <IconHelpCircle size={16} color="var(--mantine-color-yellow-5)" />
  ) : choice === "skip" ? (
    <IconCheck size={16} color="var(--mantine-color-teal-5)" />
  ) : (
    <IconAdjustmentsHorizontal size={16} />
  );

export function ToolGrantModal({
  agentName,
  onApply,
  onClose,
  ...rest
}: Props) {
  const [grant, setGrant] = useState(rest.grant);
  const [approval, setApproval] = useState(rest.approval);
  const { newTools } = rest;
  const edit = toolEditing({
    ...rest,
    grant,
    onGrant: setGrant,
    approval,
    onApproval: setApproval,
  });
  const [selected, setSelected] = useState(
    () =>
      (
        edit.sections.find((s) => s.tools.some((t) => newTools.has(t.name))) ??
        edit.sections.find((s) =>
          s.tools.some((t) => !t.alwaysOn && hasTool(grant, t)),
        ) ??
        edit.sections[0]
      )?.id ?? "",
  );
  const current = edit.sections.find((s) => s.id === selected);

  const renderRow = (t: AgentToolInfo) => {
    const info = edit.approvalOf(t.name);
    const on = hasTool(grant, t);
    const value = approval[t.name];

    return (
      <Box key={t.name} className={classes.row}>
        <Checkbox
          className={classes.center}
          aria-label={t.name}
          checked={on}
          disabled={t.alwaysOn}
          onChange={(e) => setGrant(setTool(grant, t, e.currentTarget.checked))}
        />
        <Stack gap={2} miw={0}>
          <Group gap={8}>
            <Text size="sm" fw={600}>
              {t.name}
            </Text>
            <ToolBadges tool={t} isNew={newTools.has(t.name)} />
          </Group>
          <Text size="xs" c="dimmed" lineClamp={2}>
            {t.description}
          </Text>
        </Stack>
        {info?.fixed ? (
          <Stack gap={2}>
            <Group gap={6}>
              <IconLock size={14} />
              <Text size="sm">Always asks</Text>
            </Group>
            <Text size="xs" c="dimmed">
              The tool fixes this; it can&apos;t be changed.
            </Text>
          </Stack>
        ) : (
          <Stack gap={4}>
            <ApprovalChoice
              label={`Approval for ${t.name}`}
              value={value === undefined ? "own" : value ? "ask" : "skip"}
              disabled={!on || !info}
              onChange={(v) =>
                edit.setAsk(t.name, v === "own" ? undefined : v === "ask")
              }
            />
            {value === undefined && (
              <Text size="xs" c="dimmed">
                {info?.ask ? "The tool asks." : "The tool doesn't ask."}
              </Text>
            )}
          </Stack>
        )}
      </Box>
    );
  };

  const renderGroupApproval = (s: ToolSection<AgentToolInfo>, what: string) => (
    <Paper withBorder p="sm" radius="md">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Stack gap={0}>
          <Text size="sm" fw={600}>
            Asks before running
          </Text>
          <Text size="xs" c="dimmed">
            For every tool in {what}.
          </Text>
        </Stack>
        <Box w="22rem" flex="none">
          <ApprovalChoice
            label={`Approval for ${s.label} tools`}
            value={edit.choiceOf(s.tools)}
            onChange={(v) => edit.setChoice(s.tools, v)}
          />
        </Box>
      </Group>
    </Paper>
  );

  const table = (list: AgentToolInfo[]) => (
    <Box>
      <Box className={classes.head}>
        <span className={classes.center}>Allowed</span>
        <span>Tool</span>
        <span>Asks before running</span>
      </Box>
      {list.map(renderRow)}
    </Box>
  );

  return (
    <Modal
      opened
      onClose={onClose}
      centered
      size="60rem"
      title="Tool permissions"
    >
      <Group
        justify="space-between"
        wrap="nowrap"
        px="md"
        py="xs"
        className={classes.bar}
      >
        <Text size="sm" c="dimmed" truncate>
          {agentName || "New agent"}
        </Text>
        <SegmentedControl
          size="xs"
          value={grant.mode}
          onChange={(v) =>
            setGrant(switchMode(grant, v as ToolMode, rest.tools))
          }
          data={[
            { value: "allow", label: "Only the ticked tools" },
            { value: "deny", label: "Every tool except the unticked ones" },
          ]}
        />
      </Group>

      <Flex h="min(36rem, 65vh)" mih={0}>
        <ScrollArea w="16rem" flex="none" p="xs" className={classes.nav}>
          <Stack gap={2} role="list" aria-label="Tool groups">
            {edit.sections.map((s) => {
              const state = toggleState(grant, s.tools);
              const { on, total } = groupCount(grant, s.tools);

              return (
                <Group
                  key={s.id}
                  role="listitem"
                  gap="xs"
                  wrap="nowrap"
                  px="xs"
                  className={classes.navItem}
                  data-selected={s.id === selected || undefined}
                >
                  <Checkbox
                    aria-label={`${s.label} tools`}
                    checked={state === "all"}
                    indeterminate={state === "mixed"}
                    onChange={() =>
                      setGrant(
                        setGroup(grant, s.group, s.tools, state !== "all"),
                      )
                    }
                  />
                  <UnstyledButton
                    flex={1}
                    miw={0}
                    py="xs"
                    aria-current={s.id === selected ? "true" : undefined}
                    onClick={() => setSelected(s.id)}
                  >
                    <Group gap="xs" wrap="nowrap">
                      <Text size="sm" flex={1} miw={0} truncate>
                        {s.label}
                      </Text>
                      {state !== "none" && groupIcon(edit.choiceOf(s.tools))}
                      <Text size="xs" c="dimmed">
                        {on}/{total}
                      </Text>
                    </Group>
                  </UnstyledButton>
                </Group>
              );
            })}
          </Stack>
        </ScrollArea>

        <ScrollArea flex={1} miw={0}>
          {current && (
            <Stack gap="md" p="md">
              <Group gap="sm" wrap="nowrap">
                <Text fw={600} size="lg">
                  {current.label}
                </Text>
                <Text size="sm" c="dimmed" flex={1}>
                  {`${groupCount(grant, current.tools).on} of ${current.tools.length} allowed`}
                </Text>
                <Button
                  size="compact-sm"
                  variant="default"
                  onClick={() =>
                    setGrant(
                      setGroup(grant, current.group, current.tools, true),
                    )
                  }
                >
                  Allow all
                </Button>
                <Button
                  size="compact-sm"
                  variant="default"
                  onClick={() =>
                    setGrant(
                      setGroup(grant, current.group, current.tools, false),
                    )
                  }
                >
                  Allow none
                </Button>
              </Group>
              {renderGroupApproval(current, "this group")}
              {current.children
                ? current.children.map((server) => {
                    const state = toggleState(grant, server.tools);

                    return (
                      <Stack key={server.id} gap="xs">
                        <Group gap="sm" wrap="nowrap">
                          <Checkbox
                            aria-label={`${server.label} tools`}
                            checked={state === "all"}
                            indeterminate={state === "mixed"}
                            onChange={() =>
                              setGrant(
                                setTools(grant, server.tools, state !== "all"),
                              )
                            }
                          />
                          <Text size="sm" fw={600} flex={1}>
                            {server.label}
                          </Text>
                          <Box w="22rem" flex="none">
                            <ApprovalChoice
                              label={`Approval for ${server.label} tools`}
                              value={edit.choiceOf(server.tools)}
                              onChange={(v) => edit.setChoice(server.tools, v)}
                            />
                          </Box>
                        </Group>
                        {table(server.tools)}
                      </Stack>
                    );
                  })
                : table(current.tools)}
            </Stack>
          )}
        </ScrollArea>
      </Flex>

      <Group
        justify="space-between"
        wrap="nowrap"
        px="md"
        py="xs"
        className={classes.footer}
      >
        <Text size="xs" c="dimmed">
          Saving the agent counts new tools as seen.
        </Text>
        <Group gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onApply(grant, approval)}>Done</Button>
        </Group>
      </Group>
    </Modal>
  );
}

import {
  Badge,
  Group,
  Menu,
  SegmentedControl,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  IconAdjustmentsHorizontal,
  IconCheck,
  IconChevronDown,
  IconHelpCircle,
  IconLock,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { AgentToolInfo, ToolApprovalInfo } from "../../../api";
import {
  groupApproval,
  sectionTools,
  setGroupApproval,
  type GroupApproval,
  type ToolGrant,
} from "../../../lib/tool-grant";

export interface ToolEditorProps {
  grant: ToolGrant;
  onGrant: (g: ToolGrant) => void;
  approval: Record<string, boolean>;
  onApproval: (a: Record<string, boolean>) => void;
  tools: AgentToolInfo[];
  approvals: ToolApprovalInfo[];
  newTools: ReadonlySet<string>;
}

export type Approval = Exclude<GroupApproval, "mixed">;

const CHOICES: { value: Approval; label: string; icon: ReactNode }[] = [
  {
    value: "own",
    label: "Tool's setting",
    icon: <IconAdjustmentsHorizontal size={14} />,
  },
  {
    value: "ask",
    label: "Ask",
    icon: <IconHelpCircle size={14} color="var(--mantine-color-yellow-5)" />,
  },
  {
    value: "skip",
    label: "Don't ask",
    icon: <IconCheck size={14} color="var(--mantine-color-teal-5)" />,
  },
];

export function ApprovalChoice({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: GroupApproval;
  onChange: (value: Approval) => void;
  disabled?: boolean;
}) {
  return (
    <SegmentedControl
      size="xs"
      fullWidth
      aria-label={label}
      disabled={disabled}
      value={value === "mixed" ? "" : value}
      onChange={(v) => onChange(v as Approval)}
      data={CHOICES.map((c) => ({
        value: c.value,
        label: (
          <Group gap={4} wrap="nowrap" justify="center">
            {c.icon}
            <span>{c.label}</span>
          </Group>
        ),
      }))}
    />
  );
}

export function ToolBadges({
  tool,
  isNew,
}: {
  tool: AgentToolInfo;
  isNew: boolean;
}) {
  return (
    <>
      {tool.alwaysOn && (
        <Badge variant="outline" color="gray">
          always on
        </Badge>
      )}
      {isNew && <Badge color="blue">new</Badge>}
      {tool.needsReview && <Badge color="orange">needs review</Badge>}
      {tool.off && <Badge color="red">off in Settings</Badge>}
    </>
  );
}

const defaultText = (tool: ToolApprovalInfo | undefined) =>
  `Tool's setting: ${tool?.ask ? "asks" : "doesn't ask"}`;

export function ToolApprovalMenu({
  tool,
  value,
  disabled,
  onChange,
}: {
  tool: ToolApprovalInfo | undefined;
  value: boolean | undefined;
  disabled: boolean;
  onChange: (value: boolean | undefined) => void;
}) {
  if (tool?.fixed) {
    return (
      <Group gap={4} wrap="nowrap">
        <IconLock size={14} />
        <Text size="xs" c="dimmed">
          Always asks. The tool fixes this.
        </Text>
      </Group>
    );
  }

  const current =
    value === undefined ? defaultText(tool) : value ? "Ask" : "Don't ask";
  const items: { label: string; value: boolean | undefined }[] = [
    { label: defaultText(tool), value: undefined },
    { label: "Ask", value: true },
    { label: "Don't ask", value: false },
  ];

  return (
    <Menu disabled={disabled || !tool} position="bottom-start" withinPortal>
      <Menu.Target>
        <UnstyledButton
          disabled={disabled || !tool}
          aria-label={`Approval for ${tool?.name ?? "this tool"}`}
          opacity={disabled ? 0.55 : 1}
          c="var(--mantine-color-anchor)"
          fz="xs"
          td="underline"
        >
          <Group gap={2} wrap="nowrap">
            {current}
            <IconChevronDown size={12} />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {items.map((i) => (
          <Menu.Item
            key={i.label}
            rightSection={i.value === value ? <IconCheck size={14} /> : null}
            onClick={() => onChange(i.value)}
          >
            {i.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

export function toolEditing(p: ToolEditorProps) {
  const sections = sectionTools(p.tools);
  const all = sections.flatMap((g) => [g, ...(g.children ?? [])]);
  const approvalOf = (name: string) => p.approvals.find((t) => t.name === name);
  const isFixed = (name: string) => approvalOf(name)?.fixed ?? false;
  const refs = (list: readonly AgentToolInfo[]) =>
    list.map((t) => ({ name: t.name, fixed: isFixed(t.name) }));
  const known = new Set(p.tools.map((t) => t.name));

  return {
    sections,
    all,
    approvalOf,
    setAsk: (tool: string, ask: boolean | undefined) => {
      const rest = Object.fromEntries(
        Object.entries(p.approval).filter(([n]) => n !== tool),
      );

      p.onApproval(ask === undefined ? rest : { ...rest, [tool]: ask });
    },
    choiceOf: (list: readonly AgentToolInfo[]) =>
      groupApproval(p.approval, refs(list)),
    setChoice: (list: readonly AgentToolInfo[], value: Approval) =>
      p.onApproval(setGroupApproval(p.approval, refs(list), value)),
    missing: [...p.grant.except, ...p.grant.extras].filter(
      (n, i, names) => !known.has(n) && names.indexOf(n) === i,
    ),
    missingApproval: Object.keys(p.approval).filter(
      (n) => p.approvals.length > 0 && !approvalOf(n),
    ),
  };
}

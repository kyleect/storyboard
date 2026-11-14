import {
  Badge,
  Button,
  Chip,
  Code,
  Group,
  Paper,
  Select,
  Spoiler,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useMemo, useState } from "react";
import type { SessionDebug } from "../../../api";
import { runLabel, shortId } from "../lib/debug";
import {
  buildLinear,
  filterLinear,
  LINEAR_KINDS,
  NO_LINEAR_FILTER,
  type LinearFilter,
  type LinearItem,
  type LinearKind,
} from "../lib/linear";

const COLORS: Record<LinearKind, string> = {
  system: "gray",
  tools: "gray",
  user: "blue",
  assistant: "teal",
  tool: "grape",
  edit: "yellow",
  event: "dark",
};

const LABELS: Record<LinearKind, string> = {
  system: "System",
  tools: "Tools",
  user: "User",
  assistant: "Assistant",
  tool: "Tool result",
  edit: "Edits",
  event: "Events",
};

const pre = { whiteSpace: "pre-wrap", wordBreak: "break-word" } as const;

function Body({ item }: { item: LinearItem }) {
  const maxHeight = item.kind === "system" || item.kind === "tools" ? 72 : 240;
  return (
    <Spoiler maxHeight={maxHeight} showLabel="Show more" hideLabel="Show less">
      <Stack gap={6}>
        {item.text !== undefined && item.text !== "" && (
          <Text size="sm" style={pre}>
            {item.text}
          </Text>
        )}
        {item.blocks?.map((b, i) =>
          b.type === "reasoning" ? (
            <div key={i}>
              <Text size="xs" c="dimmed" fw={600}>
                Reasoning
              </Text>
              <Text size="sm" c="dimmed" fs="italic" style={pre}>
                {b.text}
              </Text>
            </div>
          ) : b.type === "text" ? (
            <Text key={i} size="sm" style={pre}>
              {b.text}
            </Text>
          ) : (
            <div key={i}>
              <Text size="xs" c="dimmed" fw={600}>
                Calls {b.name}
                {item.calls?.[b.callId] ? ` → ${item.calls[b.callId]}` : ""}
              </Text>
              <Code block style={pre}>
                {typeof b.arguments === "string"
                  ? b.arguments
                  : JSON.stringify(b.arguments, null, 2)}
              </Code>
            </div>
          ),
        )}
      </Stack>
    </Spoiler>
  );
}

function File({ item, runs }: { item: LinearItem; runs: Map<string, string> }) {
  const [json, setJson] = useState(false);
  const color =
    item.isError === true && item.kind !== "event" ? "red" : COLORS[item.kind];
  const empty =
    (item.text === undefined || item.text === "") &&
    (item.blocks === undefined || item.blocks.length === 0);
  return (
    <Paper
      withBorder
      p="xs"
      ml={item.depth * 24}
      style={{ borderLeft: `4px solid var(--mantine-color-${color}-6)` }}
    >
      <Stack gap={4}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap="xs" wrap="nowrap">
            <Badge size="sm" variant="light" color={color}>
              {item.kind === "event" ? "event" : LABELS[item.kind]}
            </Badge>
            <Text size="sm" fw={600}>
              {item.title}
            </Text>
          </Group>
          <Group gap="xs" wrap="nowrap">
            {item.runId !== null && (
              <Text size="xs" c="dimmed" title={item.runId}>
                run {runs.get(item.runId) ?? shortId(item.runId)}
              </Text>
            )}
            {item.time !== null && (
              <Text size="xs" c="dimmed" title={item.time}>
                {item.time.slice(11, 23)}
              </Text>
            )}
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => setJson(!json)}
            >
              {json ? "Hide JSON" : "JSON"}
            </Button>
          </Group>
        </Group>
        {item.meta && (
          <Text size="xs" c="dimmed">
            {item.meta}
          </Text>
        )}
        {!empty && <Body item={item} />}
        {json && (
          <Code block style={pre}>
            {JSON.stringify(item.raw, null, 2)}
          </Code>
        )}
      </Stack>
    </Paper>
  );
}

export function LinearView({ debug }: { debug: SessionDebug }) {
  const [filter, setFilter] = useState<LinearFilter>(NO_LINEAR_FILTER);
  const items = useMemo(() => buildLinear(debug), [debug]);
  const shown = useMemo(() => filterLinear(items, filter), [items, filter]);
  const runNumbers = useMemo(
    () =>
      new Map(debug.runs.map((r, i) => [r.id, `${i + 1}. ${shortId(r.id)}`])),
    [debug],
  );

  return (
    <Stack gap="sm">
      <Group gap="sm" align="flex-end" wrap="wrap">
        <TextInput
          label="Search"
          placeholder="text, tool, JSON…"
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
          style={{ flex: 1, minWidth: 180 }}
        />
        <Select
          label="Run"
          placeholder="All runs"
          data={debug.runs.map((r, i) => ({
            value: r.id,
            label: runLabel(r, i),
          }))}
          value={filter.runId}
          onChange={(runId) => setFilter({ ...filter, runId })}
          clearable
          style={{ minWidth: 220 }}
        />
      </Group>
      <Chip.Group
        multiple
        value={[...filter.kinds]}
        onChange={(kinds) =>
          setFilter({ ...filter, kinds: kinds as LinearKind[] })
        }
      >
        <Group gap="xs">
          {LINEAR_KINDS.map((k) => (
            <Chip key={k} value={k} size="xs" color={COLORS[k]}>
              {LABELS[k]}
            </Chip>
          ))}
        </Group>
      </Chip.Group>

      <Text size="xs" c="dimmed">
        Showing {shown.length.toLocaleString()} of{" "}
        {items.length.toLocaleString()} items, oldest first.
      </Text>

      {items.length === 0 && <Text c="dimmed">Nothing has happened yet.</Text>}
      {shown.map((item) => (
        <File key={item.key} item={item} runs={runNumbers} />
      ))}
    </Stack>
  );
}

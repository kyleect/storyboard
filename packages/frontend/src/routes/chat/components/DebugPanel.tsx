import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Menu,
  MultiSelect,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import utils from "../../../styles/utilities.module.css";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type DebugRun, type SessionDebug } from "../../../api";
import { sessionKeys } from "../../../queries";
import { renderLinearText } from "../lib/linear";
import {
  copyText,
  eventSummary,
  filterEvents,
  NO_FILTER,
  runLabel,
  shortId,
  type EventFilter,
} from "../lib/debug";
import { LinearView } from "./LinearView";

export const MAX_ROWS = 500;

type CopyFormat = "text" | "json";

const FORMATS: Record<CopyFormat, (debug: SessionDebug) => string> = {
  text: renderLinearText,
  json: (debug) => JSON.stringify(debug, null, 2),
};

export function CopyDebugButton({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false);
  const copy = (format: CopyFormat) => {
    setBusy(true);
    const text = api.getSessionDebug(sessionId).then(FORMATS[format]);
    copyText(text)
      .then(async () =>
        notifications.show({
          color: "green",
          title: "Copied",
          message: `Session ${format === "text" ? "text" : "JSON"} copied (${(await text).length.toLocaleString()} characters).`,
        }),
      )
      .catch((err: unknown) =>
        notifications.show({
          color: "red",
          title: "Could not copy the session",
          message: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Button.Group>
      <Button
        size="xs"
        variant="default"
        loading={busy}
        onClick={() => copy("text")}
        title="Copy the linear view as text: system prompts, messages, tool calls and events in order"
      >
        Copy
      </Button>
      <Menu position="bottom-end">
        <Menu.Target>
          <Button
            size="xs"
            variant="default"
            px={6}
            disabled={busy}
            aria-label="More ways to copy"
          >
            ▾
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            onClick={() => copy("json")}
            title="Copy the whole export as JSON"
          >
            Export
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Button.Group>
  );
}

function RunRequest({ run, index }: { run: DebugRun; index: number }) {
  return (
    <Paper p="sm">
      <Stack gap="xs">
        <Group gap="xs">
          <Text fw={600} size="sm">
            {runLabel(run, index)}
          </Text>
          {run.model && <Badge size="md">{run.model}</Badge>}
          {run.reasoningEffort && (
            <Badge size="md" color="grape">
              {run.reasoningEffort}
            </Badge>
          )}
          {run.parentRunId && (
            <Badge size="md" color="gray">
              parent {shortId(run.parentRunId)}
            </Badge>
          )}
        </Group>
        {run.request === "not_recorded" ? (
          <Text size="sm" c="dimmed">
            Not recorded: this run was made before system prompts were kept.
          </Text>
        ) : (
          <>
            <Text size="xs" c="dimmed" fw={600}>
              System prompt
            </Text>
            {run.systemPrompt ? (
              <Code block className={utils.preWrap}>
                {run.systemPrompt}
              </Code>
            ) : (
              <Text size="sm" c="dimmed">
                None was sent.
              </Text>
            )}
            <Text size="xs" c="dimmed" fw={600}>
              Tools ({run.tools?.length ?? 0})
            </Text>
            {run.tools && run.tools.length > 0 ? (
              <Code block className={utils.preWrap}>
                {JSON.stringify(run.tools, null, 2)}
              </Code>
            ) : (
              <Text size="sm" c="dimmed">
                None offered.
              </Text>
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
}

export function DebugPanel({ sessionId }: { sessionId: string }) {
  const query = useQuery({
    queryKey: sessionKeys.debug(sessionId),
    queryFn: () => api.getSessionDebug(sessionId),
    staleTime: 0,
    gcTime: 0,
  });
  const [view, setView] = useState<string>("linear");
  const [filter, setFilter] = useState<EventFilter>(NO_FILTER);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  const debug = query.data;
  const shown = useMemo(
    () => (debug ? filterEvents(debug.events, filter) : []),
    [debug, filter],
  );
  const types = useMemo(
    () => [...new Set(debug?.events.map((e) => e.type) ?? [])].sort(),
    [debug],
  );
  const runIndex = new Map(debug?.runs.map((r, i) => [r.id, i]) ?? []);

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (query.isPending) return <Loader size="sm" />;
  if (query.isError || !debug) {
    return (
      <Alert color="red" title="Could not load the session export">
        {query.error instanceof Error ? query.error.message : "Unknown error."}
      </Alert>
    );
  }

  return (
    <Stack gap="sm" pb="md">
      <Group justify="space-between">
        <SegmentedControl
          size="xs"
          value={view}
          onChange={setView}
          data={[
            { value: "linear", label: "Linear" },
            { value: "events", label: `Events (${debug.events.length})` },
            { value: "requests", label: `Requests (${debug.runs.length})` },
          ]}
        />
        <Group gap="xs">
          <CopyDebugButton sessionId={sessionId} />
          <Button
            size="xs"
            variant="default"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh
          </Button>
        </Group>
      </Group>

      {view === "linear" ? (
        <LinearView debug={debug} />
      ) : view === "requests" ? (
        <Stack gap="sm">
          {debug.runs.length === 0 && <Text c="dimmed">No runs yet.</Text>}
          {debug.runs.map((run, i) => (
            <RunRequest key={run.id} run={run} index={i} />
          ))}
        </Stack>
      ) : (
        <>
          <Group gap="sm" align="flex-end" wrap="wrap">
            <TextInput
              label="Search"
              placeholder="type, run, text, JSON…"
              value={filter.text}
              onChange={(e) => setFilter({ ...filter, text: e.target.value })}
              flex={1}
              miw={180}
            />
            <MultiSelect
              label="Type"
              placeholder={filter.types.length === 0 ? "All types" : undefined}
              data={types}
              value={[...filter.types]}
              onChange={(types) => setFilter({ ...filter, types })}
              searchable
              clearable
              miw={220}
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
              miw={220}
            />
            <Switch
              label="Hide streaming deltas"
              checked={filter.hideStreaming}
              onChange={(e) =>
                setFilter({ ...filter, hideStreaming: e.currentTarget.checked })
              }
              pb={6}
            />
          </Group>

          <Text size="xs" c="dimmed">
            Showing {Math.min(shown.length, MAX_ROWS).toLocaleString()} of{" "}
            {shown.length.toLocaleString()} matching events (
            {debug.events.length.toLocaleString()} in total).
            {shown.length > MAX_ROWS && " Narrow the filters to see the rest."}
          </Text>

          <ScrollArea>
            <Table stickyHeader highlightOnHover withTableBorder fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>#</Table.Th>
                  <Table.Th>Time</Table.Th>
                  <Table.Th>Run</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Summary</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shown.slice(0, MAX_ROWS).map((e) => {
                  const expanded = open.has(e.id);
                  const index =
                    e.runId === null ? undefined : runIndex.get(e.runId);
                  return [
                    <Table.Tr
                      key={e.id}
                      onClick={() => toggle(e.id)}
                      className={utils.pointer}
                      aria-expanded={expanded}
                    >
                      <Table.Td>{e.id}</Table.Td>
                      <Table.Td title={e.time}>{e.time.slice(11, 23)}</Table.Td>
                      <Table.Td>
                        {e.runId === null
                          ? "—"
                          : index === undefined
                            ? shortId(e.runId)
                            : `${index + 1}. ${shortId(e.runId)}`}
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm">{e.type}</Badge>
                      </Table.Td>
                      <Table.Td className={utils.breakWord}>
                        {eventSummary(e)}
                      </Table.Td>
                    </Table.Tr>,
                    expanded && (
                      <Table.Tr key={`${e.id}-data`}>
                        <Table.Td colSpan={5}>
                          <Code block className={utils.preWrap}>
                            {JSON.stringify(e.data, null, 2)}
                          </Code>
                        </Table.Td>
                      </Table.Tr>
                    ),
                  ];
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </>
      )}
    </Stack>
  );
}

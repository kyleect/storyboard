import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  api,
  type McpConfig,
  type McpServerInput,
  type McpServerView,
  type McpState,
} from "../api";
import { mcpKeys, toolKeys } from "../queries";
import {
  formatEnv,
  formatHeaders,
  formatLines,
  parseEnv,
  parseHeaders,
  parseLines,
} from "../mcp-form";

/*
 * The Settings MCP servers section (MCP design): the servers the backend
 * connects to, each with its connection status and the tools it gives. The
 * tools themselves are set up (always on, approval, off) in the tools
 * section, under the MCP group, and granted to agents like any other.
 */

const STATE_COLOR: Record<McpState, string> = {
  connected: "green",
  connecting: "blue",
  failed: "red",
  disabled: "gray",
};

/** The form's values: lists as text, one entry per line. */
interface FormValues {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
}

const blank = (): FormValues => ({
  name: "",
  enabled: true,
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  cwd: "",
  url: "",
  headers: "",
});

function valuesOf(server: McpServerView): FormValues {
  const c = server.config;
  return {
    ...blank(),
    name: server.name,
    enabled: server.enabled,
    transport: c.transport,
    ...(c.transport === "stdio"
      ? {
          command: c.command,
          args: formatLines(c.args),
          env: formatEnv(c.env),
          cwd: c.cwd ?? "",
        }
      : { url: c.url, headers: formatHeaders(c.headers) }),
  };
}

/** The settings the form describes. Throws a readable error for a bad line. */
function inputOf(v: FormValues): McpServerInput {
  const config: McpConfig =
    v.transport === "stdio"
      ? {
          transport: "stdio",
          command: v.command.trim(),
          args: parseLines(v.args),
          env: parseEnv(v.env),
          ...(v.cwd.trim() !== "" ? { cwd: v.cwd.trim() } : {}),
        }
      : {
          transport: "http",
          url: v.url.trim(),
          headers: parseHeaders(v.headers),
        };
  return { name: v.name.trim(), enabled: v.enabled, config };
}

const summary = (c: McpConfig) =>
  c.transport === "stdio" ? [c.command, ...c.args].join(" ") : c.url;

export function McpServers() {
  const queryClient = useQueryClient();
  const servers = useQuery({
    queryKey: mcpKeys.list(),
    queryFn: api.listMcpServers,
  });
  /** The server being edited; "new": the form for a new one. */
  const [editing, setEditing] = useState<McpServerView | "new" | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: mcpKeys.all });
    void queryClient.invalidateQueries({ queryKey: toolKeys.list() });
  };
  const failed = (title: string) => (err: Error) =>
    notifications.show({ color: "red", title, message: err.message });

  const toggle = useMutation({
    mutationFn: (s: McpServerView) =>
      api.saveMcpServer(s.id, {
        name: s.name,
        enabled: !s.enabled,
        config: s.config,
      }),
    onSuccess: refresh,
    onError: failed("Could not save"),
  });
  const reconnect = useMutation({
    mutationFn: (s: McpServerView) => api.reconnectMcpServer(s.id),
    onSuccess: refresh,
    onError: failed("Could not reconnect"),
  });
  const remove = useMutation({
    mutationFn: (s: McpServerView) => api.deleteMcpServer(s.id),
    onSuccess: refresh,
    onError: failed("Could not delete"),
  });

  const confirmDelete = (s: McpServerView) =>
    modals.openConfirmModal({
      title: `Delete ${s.name}?`,
      children: (
        <Text size="sm">
          Its tools are removed. Agents that list them keep the names, but will
          not get the tools until a server provides them again.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => remove.mutate(s),
    });

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Title order={4}>MCP servers</Title>
        {editing === null && (
          <Button size="xs" variant="light" onClick={() => setEditing("new")}>
            Add server
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        Servers the backend connects to over the Model Context Protocol. Their
        tools appear in the tools section under MCP, and ask before they run
        until you change that. A stdio server is a program the backend starts,
        with your permissions; add only ones you trust.
      </Text>
      {servers.isPending && <Loader size="sm" />}
      {servers.isError && <Alert color="red">{servers.error.message}</Alert>}
      {servers.data?.length === 0 && editing === null && (
        <Text size="sm" c="dimmed">
          No MCP servers.
        </Text>
      )}
      {servers.data?.map((s) =>
        editing !== "new" && editing?.id === s.id ? null : (
          <Paper key={s.id} withBorder p="sm">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Group gap="xs">
                  <Text fw={500}>{s.name}</Text>
                  <Badge
                    size="sm"
                    color={STATE_COLOR[s.status.state]}
                    variant="light"
                  >
                    {s.status.state}
                  </Badge>
                  {s.status.state === "connected" && (
                    <Text size="xs" c="dimmed">
                      {s.status.tools.length}{" "}
                      {s.status.tools.length === 1 ? "tool" : "tools"}
                    </Text>
                  )}
                </Group>
                <Text size="xs" c="dimmed" truncate>
                  {s.config.transport}: <Code>{summary(s.config)}</Code>
                </Text>
                {s.status.error && (
                  <Text size="xs" c="red" style={{ whiteSpace: "pre-wrap" }}>
                    {s.status.error}
                  </Text>
                )}
              </Stack>
              <Group gap="xs" wrap="nowrap">
                <Switch
                  aria-label={`${s.name}: enabled`}
                  checked={s.enabled}
                  disabled={toggle.isPending}
                  onChange={() => toggle.mutate(s)}
                />
                <Button
                  size="compact-xs"
                  variant="subtle"
                  disabled={!s.enabled}
                  loading={
                    reconnect.isPending && reconnect.variables?.id === s.id
                  }
                  onClick={() => reconnect.mutate(s)}
                >
                  Reconnect
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => setEditing(s)}
                >
                  Edit
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  onClick={() => confirmDelete(s)}
                >
                  Delete
                </Button>
              </Group>
            </Group>
          </Paper>
        ),
      )}
      {editing !== null && (
        <ServerForm
          server={editing === "new" ? null : editing}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </Stack>
  );
}

function ServerForm({
  server,
  onDone,
  onCancel,
}: {
  server: McpServerView | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<FormValues>(server ? valuesOf(server) : blank());
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setV((old) => ({ ...old, [key]: value }));

  const save = useMutation({
    mutationFn: (input: McpServerInput) =>
      server ? api.saveMcpServer(server.id, input) : api.createMcpServer(input),
    onSuccess: onDone,
    onError: (err: Error) => setProblem(err.message),
  });

  const submit = () => {
    setProblem(null);
    try {
      save.mutate(inputOf(v));
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  return (
    <Paper withBorder p="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack gap="xs">
          <Text fw={500}>{server ? `Edit ${server.name}` : "New server"}</Text>
          <TextInput
            label="Name"
            description="Lowercase letters, digits and '-'. Used in the tools' names: mcp_<name>_<tool>."
            required
            value={v.name}
            onChange={(e) => set("name", e.currentTarget.value)}
          />
          <SegmentedControl
            aria-label="Transport"
            value={v.transport}
            onChange={(t) => set("transport", t as FormValues["transport"])}
            data={[
              { value: "stdio", label: "Local program (stdio)" },
              { value: "http", label: "Remote (HTTP)" },
            ]}
          />
          {v.transport === "stdio" ? (
            <>
              <TextInput
                label="Command"
                placeholder="npx"
                required
                value={v.command}
                onChange={(e) => set("command", e.currentTarget.value)}
              />
              <Textarea
                label="Arguments"
                description="One per line."
                autosize
                minRows={2}
                value={v.args}
                onChange={(e) => set("args", e.currentTarget.value)}
              />
              <Textarea
                label="Environment"
                description="NAME=value, one per line. Added to a small safe set of the backend's own."
                autosize
                minRows={2}
                value={v.env}
                onChange={(e) => set("env", e.currentTarget.value)}
              />
              <TextInput
                label="Working directory"
                description="Left empty: the backend's."
                value={v.cwd}
                onChange={(e) => set("cwd", e.currentTarget.value)}
              />
            </>
          ) : (
            <>
              <TextInput
                label="URL"
                placeholder="https://example.com/mcp"
                required
                value={v.url}
                onChange={(e) => set("url", e.currentTarget.value)}
              />
              <Textarea
                label="Headers"
                description="Name: value, one per line, sent with every request (for a token, Authorization: Bearer …)."
                autosize
                minRows={2}
                value={v.headers}
                onChange={(e) => set("headers", e.currentTarget.value)}
              />
            </>
          )}
          <Switch
            label="Connect this server"
            checked={v.enabled}
            onChange={(e) => set("enabled", e.currentTarget.checked)}
          />
          {problem && <Alert color="red">{problem}</Alert>}
          <Group gap="xs">
            <Button type="submit" size="xs" loading={save.isPending}>
              Save
            </Button>
            <Button size="xs" variant="default" onClick={onCancel}>
              Cancel
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}

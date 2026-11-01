import {
  Alert,
  Button,
  Divider,
  Group,
  Loader,
  NumberInput,
  Paper,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  api,
  type Session,
  type Settings as SettingsShape,
  type SettingsView,
  type ToolView,
} from "../api";
import { ModelPicker } from "./ModelPicker";
import { ReasoningPicker } from "./ReasoningPicker";
import { showError, useSessionActions } from "./SessionActions";

export function Settings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const form = useForm<SettingsShape>({
    initialValues: {
      llamaServerUrl: "",
      model: "",
      reasoningEffort: "",
      port: 0,
      loopLimit: 1,
      trashRetentionDays: 0,
    },
    validate: {
      llamaServerUrl: (v) =>
        /^https?:\/\/.+/.test(v) ? null : "Must be an http(s) URL",
      port: (v) =>
        Number.isInteger(v) && v >= 0 && v <= 65535 ? null : "0–65535",
      loopLimit: (v) =>
        Number.isInteger(v) && v >= 1 ? null : "A whole number, 1 or more",
      trashRetentionDays: (v) =>
        Number.isInteger(v) && v >= 0 ? null : "A whole number, 0 or more",
    },
  });

  useEffect(() => {
    if (query.data) {
      form.setValues(query.data.effective);
      form.resetDirty(query.data.effective);
    }
    // Only when fresh data arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);

  const save = useMutation({
    mutationFn: api.saveSettings,
    onSuccess: (view: SettingsView) => {
      queryClient.setQueryData(["settings"], view);
      notifications.show({ color: "green", message: "Settings saved" });
    },
    onError: (err: Error) =>
      notifications.show({
        color: "red",
        title: "Could not save",
        message: err.message,
      }),
  });

  if (query.isPending) return <Loader />;
  if (query.isError) return <Alert color="red">{query.error.message}</Alert>;
  const env = query.data.overriddenByEnv;
  const envNote = (key: keyof SettingsShape) =>
    env[key] ? `Overridden by the ${env[key]} environment variable` : undefined;

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
        <Title order={3}>Settings</Title>
        <TextInput
          label="llama-server URL"
          description={envNote("llamaServerUrl")}
          {...form.getInputProps("llamaServerUrl")}
        />
        <ModelPicker
          label="Default model"
          description={
            envNote("model") ??
            "For sessions with no model chosen. Clear it to send no model name."
          }
          placeholder="None (the server decides)"
          value={form.values.model || null}
          onChange={(model) => form.setFieldValue("model", model ?? "")}
          disabled={!!env.model}
          size="sm"
          w={444}
        />
        <ReasoningPicker
          label="Default reasoning effort"
          description={
            envNote("reasoningEffort") ??
            "For sessions with none chosen. Levels are those of the default model. Clear it to send none."
          }
          placeholder="Not sent (the server decides)"
          model={form.values.model || undefined}
          value={form.values.reasoningEffort || null}
          onChange={(effort) =>
            form.setFieldValue("reasoningEffort", effort ?? "")
          }
          disabled={!!env.reasoningEffort}
          size="sm"
          w="100%"
        />
        <NumberInput
          label="Backend port"
          description={
            envNote("port") ?? "Takes effect when the backend restarts."
          }
          allowDecimal={false}
          {...form.getInputProps("port")}
        />
        <NumberInput
          label="Loop limit"
          description={
            envNote("loopLimit") ??
            "The most model calls one run makes before it stops."
          }
          allowDecimal={false}
          min={1}
          disabled={!!env.loopLimit}
          {...form.getInputProps("loopLimit")}
        />
        <NumberInput
          label="Days in the trash"
          description={
            envNote("trashRetentionDays") ??
            "Items in the trash longer than this are deleted when the backend starts. 0: never."
          }
          allowDecimal={false}
          min={0}
          disabled={!!env.trashRetentionDays}
          {...form.getInputProps("trashRetentionDays")}
        />
        <Text size="xs" c="dimmed">
          Saved to the database. Environment variables, when set, take
          precedence.
        </Text>
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
        <Divider />
        <ToolApprovals />
        <Divider />
        <TrashSection />
      </Stack>
    </form>
  );
}

/** Per-tool "ask before running" switches, saved as they change. */
function ToolApprovals() {
  const queryClient = useQueryClient();
  const tools = useQuery({ queryKey: ["tools"], queryFn: api.listTools });
  const setAsks = useMutation({
    mutationFn: (t: { name: string; ask: boolean }) =>
      api.setToolAsks(t.name, t.ask),
    onSuccess: (updated: ToolView) =>
      queryClient.setQueryData<ToolView[]>(["tools"], (old) =>
        old?.map((t) => (t.name === updated.name ? updated : t)),
      ),
    onError: (err: Error) =>
      notifications.show({
        color: "red",
        title: "Could not save",
        message: err.message,
      }),
  });

  return (
    <Stack gap="xs">
      <Title order={4}>Tools</Title>
      <Text size="xs" c="dimmed">
        Whether each tool asks before it runs. Saved when switched.
      </Text>
      {tools.isPending && <Loader size="sm" />}
      {tools.isError && <Alert color="red">{tools.error.message}</Alert>}
      {tools.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          No tools.
        </Text>
      )}
      {tools.data?.map((t) => (
        <Switch
          key={t.name}
          label={`${t.name}: ask before running`}
          description={`${t.description} Default: ${
            t.askByDefault ? "asks" : "runs without asking"
          }.`}
          checked={t.ask}
          disabled={setAsks.isPending}
          onChange={(e) =>
            setAsks.mutate({ name: t.name, ask: e.currentTarget.checked })
          }
        />
      ))}
    </Stack>
  );
}

/**
 * What is in the trash (sessions and projects design, Q3b, Q3c): open
 * read-only, restore, delete forever, or empty the trash. Deleting asks
 * first (Q4a).
 */
function TrashSection() {
  const queryClient = useQueryClient();
  const actions = useSessionActions();
  const trash = useQuery({ queryKey: ["trash"], queryFn: api.getTrash });

  const restore = useMutation({
    mutationFn: (id: string) => actions.restore(id),
    onError: showError("Could not restore"),
  });
  const refreshTrash = () =>
    queryClient.invalidateQueries({ queryKey: ["trash"] });

  const confirmDelete = (session: Session) =>
    modals.openConfirmModal({
      title: "Delete forever?",
      children: (
        <Text size="sm">
          “{session.title}” and its whole transcript will be deleted. This
          cannot be undone.
        </Text>
      ),
      labels: { confirm: "Delete forever", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        api
          .deleteSession(session.id)
          .then(refreshTrash)
          .catch(showError("Could not delete"));
      },
    });

  const confirmEmpty = () =>
    modals.openConfirmModal({
      title: "Empty the trash?",
      children: (
        <Text size="sm">
          Everything in the trash will be deleted. This cannot be undone.
        </Text>
      ),
      labels: { confirm: "Empty trash", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        api
          .emptyTrash()
          .then(refreshTrash)
          .catch(showError("Could not empty the trash"));
      },
    });

  const sessions = trash.data?.sessions ?? [];
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Title order={4}>Trash</Title>
        {sessions.length > 0 && (
          <Button size="xs" color="red" variant="light" onClick={confirmEmpty}>
            Empty trash
          </Button>
        )}
      </Group>
      {trash.isPending && <Loader size="sm" />}
      {trash.isError && <Alert color="red">{trash.error.message}</Alert>}
      {trash.data && sessions.length === 0 && (
        <Text size="sm" c="dimmed">
          The trash is empty.
        </Text>
      )}
      {sessions.map((s) => (
        <Paper key={s.id} p="xs" withBorder>
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" truncate>
                {s.title}
              </Text>
              <Text size="xs" c="dimmed">
                Trashed {new Date(s.trashed_at ?? "").toLocaleString()}
              </Text>
            </Stack>
            <Group gap="xs" wrap="nowrap">
              <Button
                size="xs"
                variant="default"
                renderRoot={(props) => (
                  <Link
                    {...props}
                    to="/sessions/$sessionId"
                    params={{ sessionId: s.id }}
                  />
                )}
              >
                Open
              </Button>
              <Button
                size="xs"
                variant="light"
                loading={restore.isPending && restore.variables === s.id}
                onClick={() => restore.mutate(s.id)}
              >
                Restore
              </Button>
              <Button
                size="xs"
                color="red"
                variant="subtle"
                onClick={() => confirmDelete(s)}
              >
                Delete forever
              </Button>
            </Group>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

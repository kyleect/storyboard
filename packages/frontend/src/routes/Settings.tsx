import {
  Alert,
  Anchor,
  Button,
  Divider,
  Group,
  Input,
  Loader,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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

/** The fields the main form saves; the session titles section has its own. */
type MainSettings = Omit<SettingsShape, keyof TitleSettings>;

type TitleSettings = Pick<
  SettingsShape,
  "autoRename" | "autoRenameSource" | "titleModel" | "titlePrompt"
>;

function mainSettings(s: SettingsShape): MainSettings {
  return {
    llamaServerUrl: s.llamaServerUrl,
    model: s.model,
    reasoningEffort: s.reasoningEffort,
    port: s.port,
    loopLimit: s.loopLimit,
    trashRetentionDays: s.trashRetentionDays,
    embeddingModel: s.embeddingModel,
  };
}

function titleSettings(s: SettingsShape): TitleSettings {
  return {
    autoRename: s.autoRename,
    autoRenameSource: s.autoRenameSource,
    titleModel: s.titleModel,
    titlePrompt: s.titlePrompt,
  };
}

/** Saves settings, showing the outcome. */
function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
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
}

/** Overridden-by-env notes for the settings page. */
function envNoteFor(view: SettingsView) {
  const env = view.overriddenByEnv;
  return (key: keyof SettingsShape) =>
    env[key] ? `Overridden by the ${env[key]} environment variable` : undefined;
}

export function Settings() {
  const query = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const form = useForm<MainSettings>({
    initialValues: {
      llamaServerUrl: "",
      model: "",
      reasoningEffort: "",
      port: 0,
      loopLimit: 1,
      trashRetentionDays: 0,
      embeddingModel: "",
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
      const values = mainSettings(query.data.effective);
      form.setValues(values);
      form.resetDirty(values);
    }
    // Only when fresh data arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);

  const save = useSaveSettings();

  if (query.isPending) return <Loader />;
  if (query.isError) return <Alert color="red">{query.error.message}</Alert>;
  const env = query.data.overriddenByEnv;
  const envNote = envNoteFor(query.data);

  return (
    <Stack maw={480}>
      <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
        <Stack>
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
          <ModelPicker
            label="Embedding model"
            description={
              envNote("embeddingModel") ??
              "A dedicated embedding model on the router, for searching files and memory by meaning. Clear it for keyword search only."
            }
            placeholder="None (keyword search only)"
            value={form.values.embeddingModel || null}
            onChange={(model) =>
              form.setFieldValue("embeddingModel", model ?? "")
            }
            disabled={!!env.embeddingModel}
            size="sm"
            w={444}
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
        </Stack>
      </form>
      <Divider />
      <SessionTitles view={query.data} />
      <Divider />
      <ToolApprovals />
      <Divider />
      <TrashSection />
    </Stack>
  );
}

/**
 * Auto-rename (auto-rename plan, decisions 1 to 4), with its own Save.
 */
function SessionTitles({ view }: { view: SettingsView }) {
  const save = useSaveSettings();
  const form = useForm<TitleSettings>({
    initialValues: titleSettings(view.effective),
    validate: {
      titlePrompt: (v) => (v.trim() !== "" ? null : "Must not be empty"),
    },
  });

  useEffect(() => {
    const values = titleSettings(view.effective);
    form.setValues(values);
    form.resetDirty(values);
    // Only when fresh data arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const env = view.overriddenByEnv;
  const envNote = envNoteFor(view);
  const off = !form.values.autoRename;
  const fromMessage = form.values.autoRenameSource === "message";

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack>
        <Title order={4}>Session titles</Title>
        <Switch
          label="Rename new sessions after the first message"
          description={
            envNote("autoRename") ?? "Only sessions still titled “New session”."
          }
          disabled={!!env.autoRename}
          {...form.getInputProps("autoRename", { type: "checkbox" })}
        />
        <Input.Wrapper
          label="Title source"
          description={
            envNote("autoRenameSource") ??
            "When the model can't write a title, the first message is used."
          }
        >
          <SegmentedControl
            display="flex"
            mt={4}
            data={[
              { value: "model", label: "Model writes it" },
              { value: "message", label: "First message" },
            ]}
            disabled={off || !!env.autoRenameSource}
            {...form.getInputProps("autoRenameSource")}
          />
        </Input.Wrapper>
        <ModelPicker
          label="Title model"
          description={
            envNote("titleModel") ??
            "The model that writes titles. Clear it to use the session's model."
          }
          placeholder="Session's model"
          value={form.values.titleModel || null}
          onChange={(model) => form.setFieldValue("titleModel", model ?? "")}
          disabled={off || fromMessage || !!env.titleModel}
          size="sm"
          w={444}
        />
        <Textarea
          label="Title prompt"
          description={
            envNote("titlePrompt") ??
            "Sent as the system message, before the first message."
          }
          autosize
          minRows={3}
          disabled={off || fromMessage || !!env.titlePrompt}
          {...form.getInputProps("titlePrompt")}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
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
 * What is in the trash (sessions and projects design, Q3b, Q3c, Q12):
 * projects with the sessions trashed with them, and sessions trashed on
 * their own. Open read-only, restore, delete forever, or empty the trash.
 * Deleting asks first (Q4a).
 */
function TrashSection() {
  const actions = useSessionActions();
  const trash = useQuery({ queryKey: ["trash"], queryFn: api.getTrash });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
  });
  const [busy, setBusy] = useState<string | null>(null);

  const run = (id: string, work: () => Promise<unknown>, failed: string) => {
    setBusy(id);
    work()
      .catch(showError(failed))
      .finally(() => setBusy(null));
  };

  const confirmDelete = (
    title: string,
    body: string,
    work: () => Promise<unknown>,
  ) =>
    modals.openConfirmModal({
      title,
      children: <Text size="sm">{body}</Text>,
      labels: { confirm: "Delete forever", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        work()
          .then(() => actions.refreshProjects())
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
          .then(() => actions.refreshProjects())
          .catch(showError("Could not empty the trash"));
      },
    });

  const trashedProjects = trash.data?.projects ?? [];
  const sessions = trash.data?.sessions ?? [];
  const empty = trashedProjects.length === 0 && sessions.length === 0;
  const projectOf = (s: Session) =>
    s.project_id === null
      ? undefined
      : (trashedProjects.find((p) => p.id === s.project_id) ??
        projects.data?.find((p) => p.id === s.project_id));

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Title order={4}>Trash</Title>
        {!empty && (
          <Button size="xs" color="red" variant="light" onClick={confirmEmpty}>
            Empty trash
          </Button>
        )}
      </Group>
      {trash.isPending && <Loader size="sm" />}
      {trash.isError && <Alert color="red">{trash.error.message}</Alert>}
      {trash.data && empty && (
        <Text size="sm" c="dimmed">
          The trash is empty.
        </Text>
      )}
      {trashedProjects.map((p) => (
        <Paper key={p.id} p="xs" withBorder>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" fw={500} truncate>
                Project: {p.name}
              </Text>
              <Text size="xs" c="dimmed">
                Trashed {new Date(p.trashed_at ?? "").toLocaleString()} ·{" "}
                {p.sessions.length === 1
                  ? "1 session"
                  : `${p.sessions.length} sessions`}
              </Text>
              {p.sessions.map((s) => (
                <Anchor
                  key={s.id}
                  size="xs"
                  renderRoot={(props) => (
                    <Link
                      {...props}
                      to="/sessions/$sessionId"
                      params={{ sessionId: s.id }}
                    />
                  )}
                >
                  {s.title}
                </Anchor>
              ))}
            </Stack>
            <Group gap="xs" wrap="nowrap">
              <Button
                size="xs"
                variant="light"
                loading={busy === p.id}
                onClick={() =>
                  run(
                    p.id,
                    () =>
                      api
                        .restoreProject(p.id)
                        .then(() => actions.refreshProjects()),
                    "Could not restore",
                  )
                }
              >
                Restore
              </Button>
              <Button
                size="xs"
                color="red"
                variant="subtle"
                onClick={() =>
                  confirmDelete(
                    "Delete project forever?",
                    `“${p.name}” and all its sessions, including any trashed on their own, will be deleted. This cannot be undone.`,
                    () => api.deleteProject(p.id),
                  )
                }
              >
                Delete forever
              </Button>
            </Group>
          </Group>
        </Paper>
      ))}
      {sessions.map((s) => {
        const project = projectOf(s);
        return (
          <Paper key={s.id} p="xs" withBorder>
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={0} style={{ minWidth: 0 }}>
                <Text size="sm" truncate>
                  {s.title}
                </Text>
                <Text size="xs" c="dimmed">
                  {project ? `In ${project.name} · ` : ""}
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
                  loading={busy === s.id}
                  onClick={() =>
                    run(
                      s.id,
                      () =>
                        actions.restore(
                          s,
                          project?.trashed_at ? project : null,
                        ),
                      "Could not restore",
                    )
                  }
                >
                  Restore
                </Button>
                <Button
                  size="xs"
                  color="red"
                  variant="subtle"
                  onClick={() =>
                    confirmDelete(
                      "Delete forever?",
                      `“${s.title}” and its whole transcript will be deleted. This cannot be undone.`,
                      () => api.deleteSession(s.id),
                    )
                  }
                >
                  Delete forever
                </Button>
              </Group>
            </Group>
          </Paper>
        );
      })}
    </Stack>
  );
}

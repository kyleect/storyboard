import {
  Alert,
  Button,
  Divider,
  Loader,
  NumberInput,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  api,
  type Settings as SettingsShape,
  type SettingsView,
  type ToolView,
} from "../api";
import { ModelPicker } from "./ModelPicker";
import { ReasoningPicker } from "./ReasoningPicker";

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
    },
    validate: {
      llamaServerUrl: (v) =>
        /^https?:\/\/.+/.test(v) ? null : "Must be an http(s) URL",
      port: (v) =>
        Number.isInteger(v) && v >= 0 && v <= 65535 ? null : "0–65535",
      loopLimit: (v) =>
        Number.isInteger(v) && v >= 1 ? null : "A whole number, 1 or more",
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
        <Text size="xs" c="dimmed">
          Saved to the database. Environment variables, when set, take
          precedence.
        </Text>
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
        <Divider />
        <ToolApprovals />
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

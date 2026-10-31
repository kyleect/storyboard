import {
  Alert,
  Button,
  Loader,
  NumberInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, type Settings as SettingsShape, type SettingsView } from "../api";
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
    },
    validate: {
      llamaServerUrl: (v) =>
        /^https?:\/\/.+/.test(v) ? null : "Must be an http(s) URL",
      port: (v) =>
        Number.isInteger(v) && v >= 0 && v <= 65535 ? null : "0–65535",
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
        <Text size="xs" c="dimmed">
          Saved to the database. Environment variables, when set, take
          precedence.
        </Text>
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}

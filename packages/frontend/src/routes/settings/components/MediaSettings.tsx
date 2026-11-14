import {
  Button,
  Divider,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SettingsView } from "../../../api";
import { blobKeys, settingsKeys } from "../../../queries";
import { ModelPicker } from "../../../components/ModelPicker";
import { showError } from "../../../lib/notify";
import {
  MEDIA_KEYS,
  DESCRIBER_KEYS,
  useSettingsFields,
  useSettingsForm,
} from "../lib/settings-form";

/** Images and audio from earlier turns that are sent again with a request. */
export function MediaInView({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, MEDIA_KEYS, {
    inlineMediaCap: (v) =>
      Number.isInteger(v) && v >= 0 ? null : "A whole number, 0 or more",
  });

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
        <Title order={4}>Images and audio in view</Title>
        <NumberInput
          label="Images and audio kept in view"
          description={
            envNote("inlineMediaCap") ??
            "The most images and audio files from earlier turns that are sent again with each request, when they are kept. The newest are sent; older ones become a text reference. Files from the current turn are always sent. 0: only the current turn's."
          }
          allowDecimal={false}
          min={0}
          disabled={!!env.inlineMediaCap}
          {...form.getInputProps("inlineMediaCap")}
        />
        <Switch
          label="Keep images and audio in view in later turns"
          description={
            envNote("keepMediaInline") ??
            "Off: a file from an earlier turn becomes a text reference unless you or the agent chose to keep it. You can choose per file in the conversation."
          }
          disabled={!!env.keepMediaInline}
          {...form.getInputProps("keepMediaInline", { type: "checkbox" })}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}
/** What is sent of images and audio, and who writes their text. */
export function MediaSettings({ view }: { view: SettingsView }) {
  return (
    <Stack>
      <MediaInView view={view} />
      <Divider />
      <MediaDescriptions view={view} />
    </Stack>
  );
}
/**
 * Who writes the text of images and audio (files unification design, D43,
 * D56), with its own Save. With no model nothing is generated. When the
 * agent or the model changes and files could be described, it asks before
 * writing anything.
 */
export function MediaDescriptions({ view }: { view: SettingsView }) {
  const queryClient = useQueryClient();
  const { form, env, envNote } = useSettingsFields(view, DESCRIBER_KEYS);
  const agents = useQuery({
    queryKey: ["agents", "describer-choices"],
    queryFn: () => api.listAgents({ scope: "global" }, false),
  });

  const save = useMutation({
    mutationFn: api.saveSettings,
    onSuccess: async (saved: SettingsView) => {
      queryClient.setQueryData(settingsKeys.all, saved);
      notifications.show({ color: "green", message: "Settings saved" });
      void queryClient.invalidateQueries({ queryKey: blobKeys.describer() });
      // Only a change of who writes the text asks. The text of existing
      // files is not touched until the user says so.
      const changed =
        saved.effective.mediaDescriberAgent !==
          view.effective.mediaDescriberAgent ||
        saved.effective.mediaDescriberModel !==
          view.effective.mediaDescriberModel;
      if (!changed) return;
      const info = await api.getMediaDescriber();
      if (info.enabled && info.files > 0) askToRegenerate(info);
    },
    onError: (err: Error) =>
      notifications.show({
        color: "red",
        title: "Could not save",
        message: err.message,
      }),
  });

  const choices = (agents.data ?? []).filter((a) => !a.deleted);

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
        <Title order={4}>Descriptions of images and audio</Title>
        <ModelPicker
          label="Media describer model"
          description={
            envNote("mediaDescriberModel") ??
            "The model that writes a description or transcript when a file is added. It must take images or audio. Clear it to write none; you can still type the text yourself."
          }
          placeholder="None (no descriptions are written)"
          value={form.values.mediaDescriberModel || null}
          onChange={(m) => form.setFieldValue("mediaDescriberModel", m ?? "")}
          disabled={!!env.mediaDescriberModel}
          size="sm"
          w={444}
        />
        <Select
          label="Media describer agent"
          description={
            envNote("mediaDescriberAgent") ??
            "Its prompt tells the model what to write. The built-in Media Describer cannot be changed; copy it to make your own. Clear it to write none."
          }
          placeholder="None (no descriptions are written)"
          clearable
          data={choices.map((a) => ({
            value: a.id,
            label: a.builtin ? `${a.name} (built in)` : a.name,
          }))}
          value={form.values.mediaDescriberAgent || null}
          onChange={(v) => form.setFieldValue("mediaDescriberAgent", v ?? "")}
          disabled={!!env.mediaDescriberAgent}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}
/** Asks whether to write descriptions for the files already there (D56). */
export function askToRegenerate(info: { files: number; empty: number }) {
  const run = (mode: "empty" | "all") => {
    modals.closeAll();
    api
      .regenerateDescriptions(mode)
      .then(({ queued }) =>
        notifications.show({
          color: "green",
          message: `Writing descriptions for ${queued} ${queued === 1 ? "file" : "files"}.`,
        }),
      )
      .catch(showError("Could not start the descriptions"));
  };
  modals.open({
    title: `Generate descriptions for ${info.files} ${info.files === 1 ? "file" : "files"}?`,
    children: (
      <Stack>
        <Text size="sm">
          {info.empty} of {info.files} have no text. Text you wrote yourself is
          never replaced.
        </Text>
        <Group>
          <Button disabled={info.empty === 0} onClick={() => run("empty")}>
            Fill the {info.empty} with no text
          </Button>
          <Button variant="default" onClick={() => run("all")}>
            Write all again
          </Button>
          <Button variant="subtle" onClick={() => modals.closeAll()}>
            Not now
          </Button>
        </Group>
      </Stack>
    ),
  });
}

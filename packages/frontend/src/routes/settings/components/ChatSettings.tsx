import {
  Button,
  Input,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { type SettingsView } from "../../../api";
import { ModelPicker } from "../../../components/ModelPicker";
import { ReasoningPicker } from "../../../components/ReasoningPicker";
import {
  MODEL_KEYS,
  SERVER_KEYS,
  PROMPT_KEYS,
  INSTRUCTION_KEYS,
  TITLE_KEYS,
  EDITING_KEYS,
  useSettingsForm,
} from "../lib/settings-form";

/**
 * The defaults for sessions that have no model, reasoning effort or
 * embedding model of their own.
 */
export function ModelSettings({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, MODEL_KEYS);

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
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
            "A dedicated embedding model on the router, for searching files by meaning. Clear it for keyword search only."
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
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}
/** Where llama-server is, and the port the backend listens on. */
export function ServerSettings({ view }: { view: SettingsView }) {
  const { form, save, envNote } = useSettingsForm(view, SERVER_KEYS, {
    llamaServerUrl: (v) =>
      /^https?:\/\/.+/.test(v) ? null : "Must be an http(s) URL",
    port: (v) =>
      Number.isInteger(v) && v >= 0 && v <= 65535 ? null : "0–65535",
  });

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
        <TextInput
          label="llama-server URL"
          description={envNote("llamaServerUrl")}
          {...form.getInputProps("llamaServerUrl")}
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
/**
 * The global system prompt (system prompts design, decision 3), with its
 * own Save.
 */
export function SystemPrompt({ view }: { view: SettingsView }) {
  const { form, save, envNote } = useSettingsForm(view, PROMPT_KEYS);

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={640}>
        <Textarea
          label="Global system prompt"
          description={
            envNote("systemPrompt") ??
            "Sent first in every chat, before the project's and the agent's prompts. Clear it to send none. Write {{skills}}, {{tools}}, {{schemas}}, {{data}}, {{agents}} or {{workspaces}} to put the list of skills, tools, schemas, data, agents (the ones it can start) or workspaces the chat has at that place. Write {{date}} or {{time}} for the date or the time of day when the run starts. Wrap text in {{#skills}}…{{/skills}} (or any other of these names) to keep it only when the chat has some, and in {{^skills}}…{{/skills}} to keep it only when it has none. Write {{files}} to list the files the chat can see. Write {{skills_instruction}}, {{tools_instruction}}, {{schemas_instruction}}, {{data_instruction}}, {{agents_instruction}}, {{workspaces_instruction}} or {{files_instruction}} for the wording that introduces a list, apart from the list."
          }
          autosize
          minRows={4}
          maxRows={20}
          disabled={!!view.overriddenByEnv.systemPrompt}
          {...form.getInputProps("systemPrompt")}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}
/**
 * The wording that introduces each list, with its own Save. Each is what its
 * placeholder expands to (`{{skills_instruction}}` and so on). For skills and
 * schemas it is also put before the list where no prompt places the list.
 */
export const INSTRUCTIONS: readonly {
  key: (typeof INSTRUCTION_KEYS)[number];
  label: string;
  placeholder: string;
}[] = [
  {
    key: "skillsInstruction",
    label: "Skills instruction",
    placeholder: "{{skills_instruction}}",
  },
  {
    key: "toolsInstruction",
    label: "Tools instruction",
    placeholder: "{{tools_instruction}}",
  },
  {
    key: "schemasInstruction",
    label: "Schemas instruction",
    placeholder: "{{schemas_instruction}}",
  },
  {
    key: "dataInstruction",
    label: "Data instruction",
    placeholder: "{{data_instruction}}",
  },
  {
    key: "agentsInstruction",
    label: "Agents instruction",
    placeholder: "{{agents_instruction}}",
  },
  {
    key: "workspacesInstruction",
    label: "Workspaces instruction",
    placeholder: "{{workspaces_instruction}}",
  },
  {
    key: "filesInstruction",
    label: "Files instruction",
    placeholder: "{{files_instruction}}",
  },
];
export function Instructions({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, INSTRUCTION_KEYS);

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={640}>
        <Text size="sm" c="dimmed">
          The wording that introduces each list in the system message. Write the
          placeholder shown under a box in a prompt to put it where you want,
          apart from the list. Each is left out when its list is empty. Where no
          prompt writes {"{{skills}}"} or {"{{skills_instruction}}"}, the skill
          list is added after the prompts with the skills wording before it; the
          same goes for schemas. The other lists are only where a prompt places
          them.
        </Text>
        {INSTRUCTIONS.map(({ key, label, placeholder }) => (
          <Textarea
            key={key}
            label={label}
            description={
              envNote(key) ??
              `Placeholder: ${placeholder}. Empty: no wording, the list alone.`
            }
            autosize
            minRows={3}
            maxRows={12}
            disabled={!!env[key]}
            {...form.getInputProps(key)}
          />
        ))}
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}
/**
 * Auto-rename (auto-rename plan, decisions 1 to 4), with its own Save.
 */
export function SessionTitles({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, TITLE_KEYS, {
    titlePrompt: (v) => (v.trim() !== "" ? null : "Must not be empty"),
  });
  const off = !form.values.autoRename;
  const fromMessage = form.values.autoRenameSource === "message";

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
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
/** What editing one of your messages does (message editing plan, B). */
export function EditingSettings({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, EDITING_KEYS);

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
        <Title order={4}>Editing messages</Title>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            When you save an edit
          </Text>
          <SegmentedControl
            data={[
              { value: "branch", label: "Keep the old one on a branch" },
              { value: "in_place", label: "Overwrite in place" },
            ]}
            disabled={!!env.editMode}
            {...form.getInputProps("editMode")}
          />
          <Text size="xs" c="dimmed">
            {envNote("editMode") ??
              "A branch keeps the old message and what followed it, and you can switch back. Overwriting changes the text and keeps what follows; the old text is gone. You can choose the other way each time you save."}
          </Text>
        </Stack>
        <Switch
          label="Answer after a branched edit"
          description={
            envNote("answerAfterEdit") ??
            "On: the model replies to the edited message right away. Off: the edit is saved and you send when ready."
          }
          disabled={!!env.answerAfterEdit}
          {...form.getInputProps("answerAfterEdit", { type: "checkbox" })}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}

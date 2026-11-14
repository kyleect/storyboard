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
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm, type UseFormInput } from "@mantine/form";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { COPY_LIMIT_MAX } from "@harness/core";
import {
  api,
  type Session,
  type Settings as SettingsShape,
  type SettingsView,
} from "../api";
import { blobKeys, projectKeys, settingsKeys, trashKeys } from "../queries";
import { ModelPicker } from "./ModelPicker";
import { ReasoningPicker } from "./ReasoningPicker";
import { showError, useSessionActions } from "./SessionActions";
import { LookAndFeel } from "./LookAndFeel";
import { McpServers } from "./McpServers";
import { Profiles } from "./Profiles";
import { ToolSettings } from "./ToolSettings";

/*
 * The settings page is a set of forms, each with its own Save that stores
 * only its own fields (the backend takes a partial settings object). The
 * forms are grouped under vertical tabs, one per area; an area with several
 * groups of settings splits them again under horizontal tabs. The tabs are
 * in the address: /settings/<area>/<section>.
 *
 *   General  Models · Server · Look & Feel
 *   Chat     System prompt · Instructions · Session titles · Editing · Media
 *   Agents   Subagents · Limits
 *   Tools    Permissions · MCP servers
 *   Trash
 */

const MODEL_KEYS = ["model", "reasoningEffort", "embeddingModel"] as const;
const SERVER_KEYS = ["llamaServerUrl", "port"] as const;
const PROMPT_KEYS = ["systemPrompt"] as const;
const INSTRUCTION_KEYS = [
  "skillsInstruction",
  "toolsInstruction",
  "schemasInstruction",
  "dataInstruction",
  "agentsInstruction",
  "workspacesInstruction",
  "filesInstruction",
] as const;
const TITLE_KEYS = [
  "autoRename",
  "autoRenameSource",
  "titleModel",
  "titlePrompt",
] as const;
const SUBAGENT_KEYS = [
  "childReminders",
  "childPrompt",
  "subagentMessageLabel",
  "subagentDepth",
] as const;
const LIMIT_KEYS = [
  "loopLimit",
  "copyLimit",
  "workspaceReadCap",
  "skillFileMaxMib",
  "skillMaxMib",
  "skillMaxFiles",
] as const;
const EDITING_KEYS = ["editMode", "answerAfterEdit"] as const;
const MEDIA_KEYS = ["inlineMediaCap", "keepMediaInline"] as const;
const DESCRIBER_KEYS = ["mediaDescriberAgent", "mediaDescriberModel"] as const;
const TRASH_KEYS = ["trashRetentionDays"] as const;

/** Saves settings, showing the outcome. */
function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.saveSettings,
    onSuccess: (view: SettingsView) => {
      queryClient.setQueryData(settingsKeys.all, view);
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

/**
 * The form for some of the settings: filled from the view (and again when it
 * changes).
 */
function useSettingsFields<K extends keyof SettingsShape>(
  view: SettingsView,
  keys: readonly K[],
  validate: NonNullable<UseFormInput<Pick<SettingsShape, K>>["validate"]> = {},
) {
  const pick = () =>
    Object.fromEntries(keys.map((k) => [k, view.effective[k]])) as Pick<
      SettingsShape,
      K
    >;
  const form = useForm<Pick<SettingsShape, K>>({
    initialValues: pick(),
    validate,
  });

  // React runs a hidden tab's effects again when the tab is shown, even with
  // the same view, so refill only for a view not yet filled in: an edit not
  // yet saved survives leaving a tab and coming back to it.
  const filled = useRef(view);
  useEffect(() => {
    if (filled.current === view) return;
    filled.current = view;
    const values = pick();
    form.setValues(values);
    form.resetDirty(values);
    // Only when fresh data arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  return {
    form,
    env: view.overriddenByEnv,
    envNote: envNoteFor(view),
  };
}

/** The form for some of the settings, with a Save that stores only them. */
function useSettingsForm<K extends keyof SettingsShape>(
  view: SettingsView,
  keys: readonly K[],
  validate?: NonNullable<UseFormInput<Pick<SettingsShape, K>>["validate"]>,
) {
  const save = useSaveSettings();
  return { ...useSettingsFields(view, keys, validate), save };
}

type Section = {
  value: string;
  label: string;
  render: (view: SettingsView) => ReactNode;
};

/** An area is a vertical tab: horizontal tabs of sections, or one page. */
type Area = {
  value: string;
  label: string;
  sections?: readonly Section[];
  render?: (view: SettingsView) => ReactNode;
};

/**
 * The areas and sections. Their values are what the address says:
 * /settings/<area>/<section>.
 */
const AREAS: readonly Area[] = [
  {
    value: "general",
    label: "General",
    sections: [
      {
        value: "models",
        label: "Models",
        render: (view) => <ModelSettings view={view} />,
      },
      {
        value: "server",
        label: "Server",
        render: (view) => <ServerSettings view={view} />,
      },
      { value: "profiles", label: "Profiles", render: () => <Profiles /> },
      { value: "look", label: "Look & Feel", render: () => <LookAndFeel /> },
    ],
  },
  {
    value: "chat",
    label: "Chat",
    sections: [
      {
        value: "system-prompt",
        label: "System prompt",
        render: (view) => <SystemPrompt view={view} />,
      },
      {
        value: "instructions",
        label: "Instructions",
        render: (view) => <Instructions view={view} />,
      },
      {
        value: "titles",
        label: "Session titles",
        render: (view) => <SessionTitles view={view} />,
      },
      {
        value: "editing",
        label: "Editing",
        render: (view) => <EditingSettings view={view} />,
      },
      {
        value: "media",
        label: "Media",
        render: (view) => <MediaSettings view={view} />,
      },
    ],
  },
  {
    value: "agents",
    label: "Agents",
    sections: [
      {
        value: "subagents",
        label: "Subagents",
        render: (view) => <Subagents view={view} />,
      },
      {
        value: "limits",
        label: "Limits",
        render: (view) => <Limits view={view} />,
      },
    ],
  },
  {
    value: "tools",
    label: "Tools",
    sections: [
      {
        value: "permissions",
        label: "Permissions",
        render: () => <ToolSettings />,
      },
      { value: "mcp", label: "MCP servers", render: () => <McpServers /> },
    ],
  },
  {
    value: "trash",
    label: "Trash",
    render: (view) => (
      <Stack>
        <TrashRetention view={view} />
        <Divider />
        <TrashSection />
      </Stack>
    ),
  },
];

/** The address of a section: its area's first, with none given. */
function settingsPath(area: Area, section?: Section) {
  const chosen = section ?? area.sections?.[0];
  return chosen ? `${area.value}/${chosen.value}` : area.value;
}

/**
 * Which area and section an address names. What it does not name, or names
 * wrongly, is the first.
 */
function resolveSettingsPath(path: string | undefined) {
  const [areaValue, sectionValue] = (path ?? "").split("/");
  const area = AREAS.find((a) => a.value === areaValue) ?? AREAS[0];
  if (!area) throw new Error("No settings areas");
  const section =
    area.sections?.find((x) => x.value === sectionValue) ?? area.sections?.[0];
  return { area, section, canonical: settingsPath(area, section) };
}

/** Horizontal tabs, for an area with several groups of settings. */
function SubTabs({
  sections,
  value,
  view,
  onChange,
}: {
  sections: readonly Section[];
  /** The chosen section; none while the area is not the one shown. */
  value: string | undefined;
  view: SettingsView;
  onChange: (section: Section) => void;
}) {
  return (
    <Tabs
      value={value ?? sections[0]?.value ?? null}
      onChange={(v) => {
        const section = sections.find((x) => x.value === v);
        if (section) onChange(section);
      }}
    >
      <Tabs.List mb="md">
        {sections.map((x) => (
          <Tabs.Tab key={x.value} value={x.value}>
            {x.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {sections.map((x) => (
        <Tabs.Panel key={x.value} value={x.value}>
          {x.render(view)}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

/**
 * The tabs are in the address (/settings/<area>/<section>), so a page of
 * settings can be linked to. Every page is one route, so going from tab to
 * tab does not remount the page and lose an edit not yet saved.
 */
export function Settings() {
  const query = useQuery({
    queryKey: settingsKeys.all,
    queryFn: api.getSettings,
  });
  const { _splat: path } = useParams({ strict: false });
  const navigate = useNavigate();
  const { area, section, canonical } = resolveSettingsPath(path);

  const go = (to: string, replace = false) =>
    void navigate({ to: "/settings/$", params: { _splat: to }, replace });

  // An address that names no area or section, or a wrong one, is replaced
  // by the one that shows.
  useEffect(() => {
    if (path !== canonical) go(canonical, true);
    // go() only calls navigate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, canonical]);

  if (query.isPending) return <Loader />;
  if (query.isError) return <Alert color="red">{query.error.message}</Alert>;
  const view = query.data;

  return (
    <Stack maw={900}>
      <Title order={3}>Settings</Title>
      <Tabs
        value={area.value}
        onChange={(v) => {
          const chosen = AREAS.find((a) => a.value === v);
          if (chosen) go(settingsPath(chosen));
        }}
        orientation="vertical"
        styles={{ tabLabel: { textAlign: "left" } }}
      >
        <Tabs.List miw={140}>
          {AREAS.map((a) => (
            <Tabs.Tab key={a.value} value={a.value}>
              {a.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {AREAS.map((a) => (
          <Tabs.Panel key={a.value} value={a.value} pl="lg">
            {a.sections ? (
              <SubTabs
                sections={a.sections}
                value={a === area ? section?.value : undefined}
                view={view}
                onChange={(x) => go(settingsPath(a, x))}
              />
            ) : (
              a.render?.(view)
            )}
          </Tabs.Panel>
        ))}
      </Tabs>
    </Stack>
  );
}

/**
 * The defaults for sessions that have no model, reasoning effort or
 * embedding model of their own.
 */
function ModelSettings({ view }: { view: SettingsView }) {
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
function ServerSettings({ view }: { view: SettingsView }) {
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
function SystemPrompt({ view }: { view: SettingsView }) {
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
const INSTRUCTIONS: readonly {
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

function Instructions({ view }: { view: SettingsView }) {
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
function SessionTitles({ view }: { view: SettingsView }) {
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
function EditingSettings({ view }: { view: SettingsView }) {
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

/** Images and audio from earlier turns that are sent again with a request. */
function MediaInView({ view }: { view: SettingsView }) {
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
function MediaSettings({ view }: { view: SettingsView }) {
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
function askToRegenerate(info: { files: number; empty: number }) {
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

/**
 * How subagents work (agent delegation design, decisions 12 to 17), with
 * its own Save. Each agent can set its own reminders and line.
 */
function Subagents({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, SUBAGENT_KEYS, {
    childReminders: (v) =>
      Number.isInteger(v) && v >= 0 ? null : "A whole number, 0 or more",
    subagentDepth: (v) =>
      Number.isInteger(v) && v >= 0 ? null : "A whole number, 0 or more",
  });

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
        <NumberInput
          label="Subagent depth"
          description={
            envNote("subagentDepth") ??
            "How many levels deep an agent can start subagents. 0 turns subagents off; 1 lets only the top-level agent start them."
          }
          allowDecimal={false}
          min={0}
          disabled={!!env.subagentDepth}
          {...form.getInputProps("subagentDepth")}
        />
        <NumberInput
          label="Reminders"
          description={
            envNote("childReminders") ??
            "How many times a subagent that stops without handing back is reminded to, before its last reply is taken as its result. Each reminder counts as one of its model calls. An agent can set its own."
          }
          allowDecimal={false}
          min={0}
          disabled={!!env.childReminders}
          {...form.getInputProps("childReminders")}
        />
        <Textarea
          label="Subagent line"
          description={
            envNote("childPrompt") ??
            "Added at the very end of a subagent's system message. An agent can set its own."
          }
          autosize
          minRows={3}
          disabled={!!env.childPrompt}
          {...form.getInputProps("childPrompt")}
        />
        {form.values.childPrompt.trim() === "" && (
          <Alert color="yellow" p="xs">
            Without this line, subagents might not work correctly: they may not
            know to hand back or to ask you with a form.
          </Alert>
        )}
        <Textarea
          label="Message label"
          description={
            envNote("subagentMessageLabel") ??
            "Put before a message you send to a running subagent, so it can tell your message from its task. Empty: no label."
          }
          autosize
          minRows={2}
          disabled={!!env.subagentMessageLabel}
          {...form.getInputProps("subagentMessageLabel")}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}

/** How much one run, one copy or move call, and one workspace read may do. */
function Limits({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, LIMIT_KEYS, {
    loopLimit: (v) =>
      Number.isInteger(v) && v >= 1 ? null : "A whole number, 1 or more",
    copyLimit: (v) =>
      Number.isInteger(v) && v >= 1 && v <= COPY_LIMIT_MAX
        ? null
        : `A whole number, 1 to ${COPY_LIMIT_MAX}`,
    workspaceReadCap: (v) =>
      Number.isInteger(v) && v >= 100 ? null : "A whole number, 100 or more",
    skillFileMaxMib: (v) =>
      Number.isInteger(v) && v >= 1 && v <= 1024
        ? null
        : "A whole number, 1 to 1024",
    skillMaxMib: (v) =>
      Number.isInteger(v) && v >= 1 && v <= 4096
        ? null
        : "A whole number, 1 to 4096",
    skillMaxFiles: (v) =>
      Number.isInteger(v) && v >= 1 && v <= 10000
        ? null
        : "A whole number, 1 to 10000",
  });

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
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
          label="Copy limit"
          description={
            envNote("copyLimit") ??
            `The most files one copy or move call may name, 1 to ${COPY_LIMIT_MAX}. Copying everything in a scope is not limited.`
          }
          allowDecimal={false}
          min={1}
          max={COPY_LIMIT_MAX}
          disabled={!!env.copyLimit}
          {...form.getInputProps("copyLimit")}
        />
        <NumberInput
          label="Workspace read size"
          description={
            envNote("workspaceReadCap") ??
            "The most characters of a workspace file one read returns. Longer files come back in parts: the agent reads the rest with an offset."
          }
          allowDecimal={false}
          min={100}
          disabled={!!env.workspaceReadCap}
          {...form.getInputProps("workspaceReadCap")}
        />
        <NumberInput
          label="Skill file size (MiB)"
          description={
            envNote("skillFileMaxMib") ??
            "The most one file in a skill may hold, 1 to 1024."
          }
          allowDecimal={false}
          min={1}
          max={1024}
          disabled={!!env.skillFileMaxMib}
          {...form.getInputProps("skillFileMaxMib")}
        />
        <NumberInput
          label="Skill size (MiB)"
          description={
            envNote("skillMaxMib") ??
            "The most all the files of one skill may hold together, 1 to 4096."
          }
          allowDecimal={false}
          min={1}
          max={4096}
          disabled={!!env.skillMaxMib}
          {...form.getInputProps("skillMaxMib")}
        />
        <NumberInput
          label="Files per skill"
          description={
            envNote("skillMaxFiles") ??
            "The most files one skill may have, 1 to 10000."
          }
          allowDecimal={false}
          min={1}
          max={10000}
          disabled={!!env.skillMaxFiles}
          {...form.getInputProps("skillMaxFiles")}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}

/** How long items stay in the trash. */
function TrashRetention({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, TRASH_KEYS, {
    trashRetentionDays: (v) =>
      Number.isInteger(v) && v >= 0 ? null : "A whole number, 0 or more",
  });

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
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
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
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
  const trash = useQuery({ queryKey: trashKeys.all, queryFn: api.getTrash });
  const projects = useQuery({
    queryKey: projectKeys.list(),
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
  const branches = trash.data?.branches ?? [];
  const empty =
    trashedProjects.length === 0 &&
    sessions.length === 0 &&
    branches.length === 0;
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
      {branches.map((b) => (
        <Paper key={b.messageId} p="xs" withBorder>
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" truncate>
                Branch: {b.preview === "" ? "(no text)" : b.preview}
              </Text>
              <Text size="xs" c="dimmed">
                In {b.sessionTitle} · {b.messages}{" "}
                {b.messages === 1 ? "message" : "messages"} · Deleted{" "}
                {new Date(b.trashedAt).toLocaleString()}
              </Text>
            </Stack>
            <Group gap="xs" wrap="nowrap">
              <Button
                size="xs"
                variant="light"
                loading={busy === b.messageId}
                onClick={() =>
                  run(
                    b.messageId,
                    () =>
                      api
                        .restoreBranch(b.messageId)
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
                    "Delete branch forever?",
                    "This branch and everything after it will be deleted. This cannot be undone.",
                    () => api.deleteTrashedBranch(b.messageId),
                  )
                }
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

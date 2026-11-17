import {
  Alert,
  Button,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { COPY_LIMIT_MAX, SHELL_TIMEOUT_LIMIT_SECONDS } from "@harness/core";
import { type SettingsView } from "../../../api";
import {
  SUBAGENT_KEYS,
  LIMIT_KEYS,
  useSettingsForm,
} from "../lib/settings-form";

export function Subagents({ view }: { view: SettingsView }) {
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
export function Limits({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, LIMIT_KEYS, {
    loopLimit: (v) =>
      Number.isInteger(v) && v >= 1 ? null : "A whole number, 1 or more",
    copyLimit: (v) =>
      Number.isInteger(v) && v >= 1 && v <= COPY_LIMIT_MAX
        ? null
        : `A whole number, 1 to ${COPY_LIMIT_MAX}`,
    workspaceReadCap: (v) =>
      Number.isInteger(v) && v >= 100 ? null : "A whole number, 100 or more",
    rolloverCarryPercent: (v) =>
      Number.isInteger(v) && v >= 1 && v <= 99
        ? null
        : "A whole number, 1 to 99",
    rolloverThresholdPercent: (v) =>
      Number.isInteger(v) && v >= 1 && v <= 99
        ? null
        : "A whole number, 1 to 99",
    rolloverHandoffPrompt: (v) =>
      v.trim() !== "" ? null : "Must not be empty",
    rolloverHandoffThinkSeconds: (v) =>
      Number.isInteger(v) && v >= 1 ? null : "A whole number, 1 or more",
    rolloverHandoffTotalSeconds: (v) =>
      Number.isInteger(v) && v >= 1 ? null : "A whole number, 1 or more",
    rolloverHandoffMaxTokens: (v) =>
      Number.isInteger(v) && v >= 1 ? null : "A whole number, 1 or more",
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
    shellTimeoutSeconds: (v) =>
      Number.isInteger(v) && v >= 1 && v <= SHELL_TIMEOUT_LIMIT_SECONDS
        ? null
        : `A whole number, 1 to ${SHELL_TIMEOUT_LIMIT_SECONDS}`,
    shellMaxTimeoutSeconds: (v) =>
      Number.isInteger(v) && v >= 1 && v <= SHELL_TIMEOUT_LIMIT_SECONDS
        ? null
        : `A whole number, 1 to ${SHELL_TIMEOUT_LIMIT_SECONDS}`,
    shellOutputCap: (v) =>
      Number.isInteger(v) && v >= 100 ? null : "A whole number, 100 or more",
  });

  const noteOff = !form.values.rolloverHandoff;

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
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            When the context is full
          </Text>
          <SegmentedControl
            data={[
              { value: "new_session", label: "Continue in a new session" },
              { value: "off", label: "Do nothing" },
            ]}
            disabled={!!env.contextFullAction}
            {...form.getInputProps("contextFullAction")}
          />
          <Text size="xs" c="dimmed">
            {envNote("contextFullAction") ??
              "When the last model call reaches the share below, the session continues in a new one with the latest messages and the current files. The old session becomes read only. Needs a model whose context size is known."}
          </Text>
        </Stack>
        <NumberInput
          label="Context full at (%)"
          description={
            envNote("rolloverThresholdPercent") ??
            "The share of the model's context that the last call used, 1 to 99, at which the session continues in a new one."
          }
          allowDecimal={false}
          min={1}
          max={99}
          disabled={!!env.rolloverThresholdPercent}
          {...form.getInputProps("rolloverThresholdPercent")}
        />
        <NumberInput
          label="Carried over to a new session (%)"
          description={
            envNote("rolloverCarryPercent") ??
            "When a session is continued in a new one because its context is full, the most recent messages that fit in this share of the model's context are copied over, 1 to 99."
          }
          allowDecimal={false}
          min={1}
          max={99}
          disabled={!!env.rolloverCarryPercent}
          {...form.getInputProps("rolloverCarryPercent")}
        />
        <Switch
          label="Write a handoff note"
          description={
            envNote("rolloverHandoff") ??
            "When a session continues in a new one, the model first writes a note about what came before the copied messages, and the new session starts with it. This can take a little while. If no note can be written, the session continues without one."
          }
          disabled={!!env.rolloverHandoff}
          {...form.getInputProps("rolloverHandoff", { type: "checkbox" })}
        />
        <Textarea
          label="Handoff note instruction"
          description={
            envNote("rolloverHandoffPrompt") ??
            "What the model is asked to write. Sent as the last message of the old session."
          }
          autosize
          minRows={6}
          maxRows={16}
          disabled={noteOff || !!env.rolloverHandoffPrompt}
          {...form.getInputProps("rolloverHandoffPrompt")}
        />
        <NumberInput
          label="Stop thinking after (seconds)"
          description={
            envNote("rolloverHandoffThinkSeconds") ??
            "How long the model may think about the note before it is told to stop and answer. The starting value has not been tested."
          }
          allowDecimal={false}
          min={1}
          disabled={noteOff || !!env.rolloverHandoffThinkSeconds}
          {...form.getInputProps("rolloverHandoffThinkSeconds")}
        />
        <NumberInput
          label="Give up after (seconds)"
          description={
            envNote("rolloverHandoffTotalSeconds") ??
            "How long the whole note may take. After this the session continues without a note. The starting value has not been tested."
          }
          allowDecimal={false}
          min={1}
          disabled={noteOff || !!env.rolloverHandoffTotalSeconds}
          {...form.getInputProps("rolloverHandoffTotalSeconds")}
        />
        <NumberInput
          label="Longest note (tokens)"
          description={
            envNote("rolloverHandoffMaxTokens") ??
            "The most the model may write for the note, thinking included. A note that is cut off is not used. The starting value has not been tested."
          }
          allowDecimal={false}
          min={1}
          disabled={noteOff || !!env.rolloverHandoffMaxTokens}
          {...form.getInputProps("rolloverHandoffMaxTokens")}
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
        <Text fw={600} mt="sm">
          Shell
        </Text>
        <NumberInput
          label="Command time limit (seconds)"
          description={
            envNote("shellTimeoutSeconds") ??
            `How long a shell command may run when the model gives no limit, 1 to ${SHELL_TIMEOUT_LIMIT_SECONDS}. Above the longest limit, the longest limit is used.`
          }
          allowDecimal={false}
          min={1}
          max={SHELL_TIMEOUT_LIMIT_SECONDS}
          disabled={!!env.shellTimeoutSeconds}
          {...form.getInputProps("shellTimeoutSeconds")}
        />
        <NumberInput
          label="Longest command time limit (seconds)"
          description={
            envNote("shellMaxTimeoutSeconds") ??
            `The longest limit the model may ask for, 1 to ${SHELL_TIMEOUT_LIMIT_SECONDS}. A longer ask is lowered to this.`
          }
          allowDecimal={false}
          min={1}
          max={SHELL_TIMEOUT_LIMIT_SECONDS}
          disabled={!!env.shellMaxTimeoutSeconds}
          {...form.getInputProps("shellMaxTimeoutSeconds")}
        />
        <NumberInput
          label="Command output size"
          description={
            envNote("shellOutputCap") ??
            "The most characters of a command's output the model reads. Longer output keeps the start and the end and cuts the middle."
          }
          allowDecimal={false}
          min={100}
          disabled={!!env.shellOutputCap}
          {...form.getInputProps("shellOutputCap")}
        />
        <TextInput
          label="Shell program"
          description={
            envNote("shellProgram") ??
            "The program that runs commands, such as /bin/zsh. Empty: your login shell."
          }
          disabled={!!env.shellProgram}
          {...form.getInputProps("shellProgram")}
        />
        <TextInput
          label="Shell arguments"
          description={
            envNote("shellArgs") ??
            "Arguments put before the command, separated by spaces. Empty: -l -c (a login shell, so commands see the same PATH as a terminal)."
          }
          disabled={!!env.shellArgs}
          {...form.getInputProps("shellArgs")}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}
